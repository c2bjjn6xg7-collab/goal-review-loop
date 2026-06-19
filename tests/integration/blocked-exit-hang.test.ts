/**
 * Phase 8D Pre-Flight P0-B: process-level regression for the BLOCKED-exit hang.
 *
 * Scenario reproduced (smoke):
 *   `review-loop start` reaches the Final Auditor, the Final Auditor returns
 *   FAILED, and the orchestrator transitions to terminal BLOCKED. Before this
 *   regression, the resulting Node process could remain alive after writing
 *   the terminal state — pending I/O, lingering subprocess references, or
 *   handler bindings kept the event loop active and required SIGKILL.
 *
 * This test spawns the built CLI as a real child process against a temp git
 * repository, configures the fake agent so the Final Auditor returns FAILED,
 * and races the child's natural exit against a 30 s deadline. If the child
 * does not exit within the deadline the test fails; if it exits, the test
 * also asserts the durable side-effects required by the GOAL:
 *   - terminal BLOCKED state persisted to .agent/state.json
 *   - no final commit was produced
 *   - the run.lock was released
 *
 * The test deliberately uses `child_process.spawn` (not the in-process
 * vitest harness) because vitest keeps the test runner's event loop alive
 * and would mask any leaked handles in the orchestrator process.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

function writeFakeAgentConfig(repoDir: string, roleBehaviors: Record<string, string>): void {
  const fakeAgentPath = resolve(join(process.cwd(), 'tests', 'fixtures', 'fake-agent.mjs'));
  const config = {
    version: 1,
    agents: {
      planner: {
        command: ['node', fakeAgentPath, '--role', 'planner', '--run-id', '{run_id}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.planner || 'success'],
        timeout_seconds: 60,
      },
      developer: {
        command: ['node', fakeAgentPath, '--role', 'developer', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.developer || 'success'],
        timeout_seconds: 60,
      },
      auditor: {
        command: ['node', fakeAgentPath, '--role', 'auditor', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.auditor || 'audit-pass'],
        timeout_seconds: 60,
      },
      final_auditor: {
        command: ['node', fakeAgentPath, '--role', 'final-auditor', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.finalAuditor || 'audit-pass'],
        timeout_seconds: 60,
      },
    },
    loop: { max_iterations: 3 },
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
    },
  };
  writeFileSync(join(repoDir, 'review-loop.yaml'), JSON.stringify(config, null, 2));
}

function copyPrompts(repoDir: string): void {
  const promptsDir = join(repoDir, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  const srcPromptsDir = join(process.cwd(), 'prompts');
  for (const f of ['planner.md', 'developer.md', 'auditor.md', 'final-auditor.md', 'rework.md']) {
    const src = join(srcPromptsDir, f);
    if (existsSync(src)) {
      copyFileSync(src, join(promptsDir, f));
    }
  }
}

function createTestRepo(suffix: string, roleBehaviors: Record<string, string> = {}): string {
  const repoDir = join(tmpdir(), `blocked-exit-hang-${suffix}-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email test@test.com', { cwd: repoDir });
  execSync('git config user.name test', { cwd: repoDir });

  writeFileSync(join(repoDir, 'README.md'), '# Test\n');
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({
    name: 'blocked-exit-hang-test',
    version: '1.0.0',
    scripts: { test: 'node -e "process.exit(0)"', typecheck: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' },
  }), 'utf8');
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'index.ts'), 'export {};\n', 'utf8');

  writeFakeAgentConfig(repoDir, roleBehaviors);
  copyPrompts(repoDir);

  execSync('git add -A', { cwd: repoDir });
  execSync('git commit -m "initial"', { cwd: repoDir });

  return repoDir;
}

interface SpawnedRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * List fake-agent child processes still alive that reference `repoDir` via
 * their `--project-root` argument. Used to assert no detached worker outlives
 * the CLI after BLOCKED finalization.
 *
 * Returns `[]` on platforms without `ps` (e.g. Windows) since the detached-
 * worker regression this guards against is POSIX-specific.
 */
function listFakeAgentProcessesForRepo(repoDir: string): number[] {
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'linux') return [];
  try {
    const out = execSync('ps -eo pid,args', { encoding: 'utf8' });
    const pids: number[] = [];
    for (const line of out.split('\n')) {
      if (line.includes('fake-agent.mjs') && line.includes(repoDir)) {
        const m = line.trim().match(/^(\d+)/);
        if (m) pids.push(parseInt(m[1], 10));
      }
    }
    return pids;
  } catch {
    return [];
  }
}

/**
 * Spawn the built CLI against a temp repo and race process exit against the
 * given deadline. If the child does not exit by `deadlineMs`, force-kill it
 * and return `timedOut: true` — the caller asserts this is false.
 */
function runCliRacing(
  repoDir: string,
  args: string[],
  deadlineMs: number,
): Promise<SpawnedRunResult> {
  const cliEntry = resolve(join(process.cwd(), 'dist', 'cli', 'main.js'));
  if (!existsSync(cliEntry)) {
    throw new Error(`CLI entry not built: ${cliEntry}. Run \`npm run build\` first.`);
  }

  return new Promise<SpawnedRunResult>((resolveResult) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [cliEntry, 'start', ...args], {
      cwd: repoDir,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    let timedOut = false;
    let killGuard: ReturnType<typeof setTimeout> | undefined;
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      // Try graceful first, then force-kill.
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      killGuard = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }, 2000);
    }, deadlineMs);

    child.on('close', (exitCode, signal) => {
      clearTimeout(deadlineTimer);
      if (killGuard) clearTimeout(killGuard);
      resolveResult({
        exitCode,
        signal: signal ?? null,
        durationMs: Date.now() - startedAt,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

describe('BLOCKED final-audit exit (process-level)', () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir) {
      try { rmSync(repoDir, { recursive: true }); } catch { /* ok */ }
    }
  });

  it(
    'forced final-audit FAILED reaches BLOCKED and the CLI process exits within 30 s',
    async () => {
      repoDir = createTestRepo('final-fail', { finalAuditor: 'audit-fail' });

      const DEADLINE_MS = 30_000;
      const result = await runCliRacing(
        repoDir,
        ['--request', 'add a feature', '--task-slug', 'blocked-exit'],
        DEADLINE_MS,
      );

      // The process must exit naturally before the deadline. The smoke bug
      // we are guarding against is "BLOCKED state written, but the Node
      // process never exits" — `timedOut: true` is the signal of regression.
      expect(result.timedOut).toBe(false);
      expect(result.signal).toBeNull();
      expect(result.durationMs).toBeLessThan(DEADLINE_MS);

      // BLOCKED on final-audit failure exits with a non-zero code (3).
      // Whatever code the CLI uses, it must not be the success code 0.
      expect(result.exitCode).not.toBe(0);

      // Terminal BLOCKED state must be persisted before exit.
      const statePath = join(repoDir, '.agent', 'state.json');
      if (!existsSync(statePath)) {
        // Surface stdout/stderr so a regression failure is debuggable.
        throw new Error(`state.json missing.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      }
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      // The hang regression specifically targets the FINAL audit FAIL → BLOCKED
      // tail. If the run BLOCKED earlier (e.g. at planning), it would not
      // exercise the same code path. Surface the actual error so a passing
      // test still proves the right scenario.
      if (state.phase !== 'BLOCKED' || !/Final Audit/i.test(state.last_error ?? '')) {
        throw new Error(
          `Unexpected blocked state: phase=${state.phase}, last_error=${state.last_error}\n` +
          `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
        );
      }
      expect(state.phase).toBe('BLOCKED');
      expect(state.last_error).toMatch(/Final Audit/i);

      // No final commit may be produced when final audit fails.
      const log = execSync('git log --oneline', { cwd: repoDir, encoding: 'utf8' }).trim();
      expect(log.split('\n').length).toBe(1);

      // The run lock must be released so a subsequent run can proceed.
      const lockPath = join(repoDir, '.agent', 'run.lock');
      expect(existsSync(lockPath)).toBe(false);

      // No known child process may remain alive after the CLI exits.
      // The BLOCKED finalization regression is specifically about detached
      // worker processes (process-runner spawns agents with detached: true)
      // outliving the orchestrator when final audit FAILs. fake-agent.mjs is
      // synchronous and exits on its own, but if process-runner ever fails to
      // tear down its detached children, those processes would linger. Give a
      // short grace for any detached child to surface, then assert none
      // references this test repo via --project-root.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const leaked = listFakeAgentProcessesForRepo(repoDir);
      expect(leaked).toEqual([]);
    },
    60_000,
  );
});
