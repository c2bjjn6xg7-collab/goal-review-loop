/**
 * Integration tests for Phase 6 custom Provider support.
 * F-603: Verifies that a non-Claude custom Provider Fake CLI
 * can drive the full orchestrator lifecycle via Provider Profile.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runOrchestrator } from '../../src/orchestrator/run-orchestrator.js';

function createCustomProviderRepo(suffix: string): string {
  const repoDir = join(tmpdir(), `review-loop-p6-provider-${suffix}-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });

  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });

  writeFileSync(join(repoDir, 'README.md'), '# Test Project\n');
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({
    name: 'test-project',
    version: '1.0.0',
    scripts: { test: 'echo "ok"', typecheck: 'echo "ok"', lint: 'echo "ok"' },
  }, null, 2));
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const hello = () => "hello";\n');
  mkdirSync(join(repoDir, 'tests'), { recursive: true });
  writeFileSync(join(repoDir, 'tests', 'index.test.ts'), 'test("hello", () => {});\n');

  // Create per-role wrapper scripts that set REVIEW_LOOP_ROLE
  const scriptsDir = join(repoDir, '.test-scripts');
  mkdirSync(scriptsDir, { recursive: true });
  const fakeAgentPath = resolve(join(process.cwd(), 'tests', 'fixtures', 'fake-agent.mjs'));

  for (const [role, behavior] of [['planner', 'success'], ['developer', 'success'], ['auditor', 'audit-pass'], ['final-auditor', 'audit-pass']]) {
    const script = `#!/bin/sh\nREVIEW_LOOP_ROLE=${role} REVIEW_LOOP_BEHAVIOR=${behavior} exec node "${fakeAgentPath}" --role ${role} --run-id "$1" --iteration "$2" --project-root "$3" --prompt-file "$4" --behavior ${behavior}\n`;
    writeFileSync(join(scriptsDir, `${role}.sh`), script, { mode: 0o755 });
  }

  // Config: custom provider per role, each using a wrapper script
  const plannerScript = join(scriptsDir, 'planner.sh');
  const developerScript = join(scriptsDir, 'developer.sh');
  const auditorScript = join(scriptsDir, 'auditor.sh');
  const finalAuditorScript = join(scriptsDir, 'final-auditor.sh');

  const config = {
    version: 1,
    providers: {
      'custom-planner': {
        enabled: true,
        command_template: ['sh', plannerScript, '{run_id}', '{iteration}', '{project_root}', '{prompt_file}'],
        prompt_transport: 'prompt_file',
        transcript_mode: 'stdout_stderr',
      },
      'custom-developer': {
        enabled: true,
        command_template: ['sh', developerScript, '{run_id}', '{iteration}', '{project_root}', '{prompt_file}'],
        prompt_transport: 'prompt_file',
        transcript_mode: 'stdout_stderr',
      },
      'custom-auditor': {
        enabled: true,
        command_template: ['sh', auditorScript, '{run_id}', '{iteration}', '{project_root}', '{prompt_file}'],
        prompt_transport: 'prompt_file',
        transcript_mode: 'stdout_stderr',
      },
      'custom-final-auditor': {
        enabled: true,
        command_template: ['sh', finalAuditorScript, '{run_id}', '{iteration}', '{project_root}', '{prompt_file}'],
        prompt_transport: 'prompt_file',
        transcript_mode: 'stdout_stderr',
      },
    },
    agents: {
      planner: { provider: 'custom-planner', command: ['placeholder'], timeout_seconds: 60 },
      developer: { provider: 'custom-developer', command: ['placeholder'], timeout_seconds: 60 },
      auditor: { provider: 'custom-auditor', command: ['placeholder'], timeout_seconds: 60 },
      final_auditor: { provider: 'custom-final-auditor', command: ['placeholder'], timeout_seconds: 60 },
    },
    loop: { max_iterations: 3 },
    git: {
      require_repository: true, require_head: true, require_clean_worktree: true,
      branch_template: 'agent/{run_id}-{task_slug}',
      commit_on_pass: true, commit_template: 'feat(agent): complete {task_slug} [{run_id}]',
      create_tag: false, tag_template: 'agent-{run_id}-pass', push: false,
    },
    runtime: { kill_grace_seconds: 5, max_log_bytes: 10485760, lock_stale_seconds: 86400 },
  };

  writeFileSync(join(repoDir, 'review-loop.yaml'), JSON.stringify(config, null, 2));

  // Copy prompts
  const promptsDir = join(repoDir, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  const srcPromptsDir = join(process.cwd(), 'prompts');
  for (const f of ['planner.md', 'developer.md', 'auditor.md', 'final-auditor.md', 'rework.md']) {
    const src = join(srcPromptsDir, f);
    if (existsSync(src)) copyFileSync(src, join(promptsDir, f));
  }

  execSync('git add -A', { cwd: repoDir });
  execSync('git commit -m "initial"', { cwd: repoDir });

  return repoDir;
}

describe('Phase 6 Custom Provider Integration', () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir) {
      try { rmSync(repoDir, { recursive: true }); } catch { /* ok */ }
    }
  });

  // F-603: Custom Provider Fake CLI drives full orchestrator lifecycle
  it('custom provider Fake CLI completes full lifecycle → PASSED with commit', async () => {
    repoDir = createCustomProviderRepo('full-run');

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a hello function',
      task_slug: 'hello-func',
    });

    // Full lifecycle must succeed
    expect(result.phase).toBe('PASSED');
    expect(result.exit_code).toBe(0);
    expect(result.commit_sha).toBeTruthy();
    expect(result.commit_sha!.length).toBeGreaterThan(0);

    // Phase 6 artifacts must exist
    expect(existsSync(join(repoDir, '.agent', 'progress.json'))).toBe(true);
    const progress = JSON.parse(readFileSync(join(repoDir, '.agent', 'progress.json'), 'utf8'));
    expect(progress.phase).toBe('PASSED');
    expect(progress.run_id).toBe(result.run_id);

    // Transcripts directory must have entries
    const transcriptsDir = join(repoDir, '.agent', 'transcripts');
    expect(existsSync(transcriptsDir)).toBe(true);

    // Lock must be released
    expect(existsSync(join(repoDir, '.agent', 'run.lock'))).toBe(false);
  });
});
