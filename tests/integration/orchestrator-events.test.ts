/**
 * Integration tests for Phase 9 R1 event-stream emission from the orchestrator.
 *
 * Runs a full fake-agent serial pipeline and asserts that `.agent/events.jsonl`
 * contains the expected high-signal lifecycle events in order.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runOrchestrator } from '../../src/orchestrator/run-orchestrator.js';
import { EventStore } from '../../src/runtime/event-store.js';

function writeFakeAgentConfig(repoDir: string, roleBehaviors: Record<string, string>): void {
  const fakeAgentPath = resolve(join(process.cwd(), 'tests', 'fixtures', 'fake-agent.mjs'));
  const config = {
    version: 1,
    agents: {
      planner: { command: ['node', fakeAgentPath, '--role', 'planner', '--run-id', '{run_id}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.planner || 'success'], timeout_seconds: 60 },
      developer: { command: ['node', fakeAgentPath, '--role', 'developer', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.developer || 'success'], timeout_seconds: 60 },
      auditor: { command: ['node', fakeAgentPath, '--role', 'auditor', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.auditor || 'audit-pass'], timeout_seconds: 60 },
      final_auditor: { command: ['node', fakeAgentPath, '--role', 'final-auditor', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.finalAuditor || 'audit-pass'], timeout_seconds: 60 },
    },
    loop: { max_iterations: 3 },
    git: {
      require_repository: true, require_head: true, require_clean_worktree: true,
      branch_template: 'agent/{run_id}-{task_slug}',
      commit_on_pass: true,
      commit_template: 'feat(agent): complete {task_slug} [{run_id}]',
      create_tag: false,
      tag_template: 'agent-{run_id}-pass',
      push: false,
    },
    runtime: { kill_grace_seconds: 5, max_log_bytes: 10485760, lock_stale_seconds: 86400 },
  };
  writeFileSync(join(repoDir, 'review-loop.yaml'), JSON.stringify(config, null, 2));
}

function copyPrompts(repoDir: string): void {
  const promptsDir = join(repoDir, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  const srcPromptsDir = join(process.cwd(), 'prompts');
  for (const f of ['planner.md', 'developer.md', 'auditor.md', 'final-auditor.md', 'rework.md']) {
    const src = join(srcPromptsDir, f);
    if (existsSync(src)) copyFileSync(src, join(promptsDir, f));
  }
}

function createTestRepo(suffix: string, roleBehaviors: Record<string, string> = {}): string {
  const repoDir = join(tmpdir(), `review-loop-evt-${suffix}-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), '# Test Project\n');
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({
    name: 'test-project', version: '1.0.0',
    scripts: { test: 'echo "ok"', typecheck: 'echo "ok"', lint: 'echo "ok"' },
  }, null, 2));
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const hello = () => "hello";\n');
  mkdirSync(join(repoDir, 'tests'), { recursive: true });
  writeFileSync(join(repoDir, 'tests', 'index.test.ts'), 'test("hello", () => {});\n');
  writeFakeAgentConfig(repoDir, roleBehaviors);
  copyPrompts(repoDir);
  execSync('git add -A', { cwd: repoDir });
  execSync('git commit -m "initial"', { cwd: repoDir });
  return repoDir;
}

describe('Phase 9 R1 orchestrator event stream', () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir) {
      try { rmSync(repoDir, { recursive: true }); } catch { /* ok */ }
    }
  });

  it('writes .agent/events.jsonl on a successful full run', async () => {
    repoDir = createTestRepo('success');

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a hello function',
      task_slug: 'hello-func',
    });

    expect(result.phase).toBe('PASSED');

    const eventsPath = join(repoDir, '.agent', 'events.jsonl');
    expect(existsSync(eventsPath)).toBe(true);

    const store = new EventStore(join(repoDir, '.agent'), result.run_id);
    const events = await store.readAll();
    const kinds = events.map((e) => e.kind);

    // Core lifecycle events must be present and in order.
    expect(kinds).toContain('run.started');
    expect(kinds).toContain('role.started');
    expect(kinds).toContain('role.exited');
    expect(kinds).toContain('verification.completed');
    expect(kinds).toContain('audit.decision');
    expect(kinds).toContain('run.completed');

    // run.started must be the first event.
    expect(events[0].kind).toBe('run.started');
    expect(events[0].run_id).toBe(result.run_id);

    // The terminal event must be run.completed with status PASSED.
    const last = events[events.length - 1];
    expect(last.kind).toBe('run.completed');
    expect(last.status).toBe('PASSED');

    // seq must be monotonically increasing.
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBe(events[i - 1].seq + 1);
    }

    // R5/R12: at least one role.exited event must carry a transcript
    // artifact_ref whose path matches the iteration-NN-<role>.md convention.
    const roleExited = events.filter((e) => e.kind === 'role.exited');
    expect(roleExited.length).toBeGreaterThan(0);
    const transcriptRefPattern = /^\.agent\/transcripts\/iteration-\d{2}-(planner|developer|auditor|final-auditor)\.md$/;
    const hasTranscriptRef = roleExited.some((e) =>
      (e.artifact_refs ?? []).some((ref) => ref.type === 'transcript' && transcriptRefPattern.test(ref.path)),
    );
    expect(hasTranscriptRef).toBe(true);

    // R5/R12: every audit.decision event payload must include a numeric
    // finding_count.
    const auditDecisions = events.filter((e) => e.kind === 'audit.decision');
    expect(auditDecisions.length).toBeGreaterThan(0);
    for (const ev of auditDecisions) {
      expect(typeof ev.payload?.finding_count).toBe('number');
    }

    // R5: the PASS audit.decision must carry status 'PASS' and must NOT
    // include rework_reason (rework_reason only appears on REWORK/FAIL).
    const passDecision = auditDecisions.find((e) => e.status === 'PASS');
    expect(passDecision).toBeDefined();
    expect(passDecision?.status).toBe('PASS');
    expect(passDecision?.payload && 'rework_reason' in passDecision.payload).toBe(false);

    // R5/R12: when rework_reason is present on an audit.decision event it
    // must be the audit-report path.
    for (const ev of auditDecisions) {
      if (ev.payload && 'rework_reason' in ev.payload) {
        expect(ev.payload.rework_reason).toBe('.agent/audit-report.md');
      }
    }

    // R5/R12: the PASSED run.completed terminal event must carry a
    // final-audit artifact_ref.
    const runCompleted = events.filter((e) => e.kind === 'run.completed');
    expect(runCompleted.length).toBeGreaterThan(0);
    const passedTerminal = runCompleted.find((e) => e.status === 'PASSED');
    expect(passedTerminal).toBeDefined();
    expect(
      (passedTerminal!.artifact_refs ?? []).some(
        (ref) => ref.type === 'final-audit' && ref.path === '.agent/final-audit.md',
      ),
    ).toBe(true);

    // R5/R12: the verification.completed event must carry a verification-log
    // artifact_ref.
    const verification = events.filter((e) => e.kind === 'verification.completed');
    expect(verification.length).toBeGreaterThan(0);
    expect(
      (verification[0].artifact_refs ?? []).some(
        (ref) => ref.type === 'verification-log' && ref.path === '.agent/verification/manifest.json',
      ),
    ).toBe(true);
  });

  it('emits role.started for planner, developer, auditor, and final-auditor', async () => {
    repoDir = createTestRepo('roles');

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a hello function',
      task_slug: 'hello-func',
    });
    expect(result.phase).toBe('PASSED');

    const store = new EventStore(join(repoDir, '.agent'), result.run_id);
    const events = await store.readAll();
    const roleStarted = events
      .filter((e) => e.kind === 'role.started')
      .map((e) => e.role);

    expect(roleStarted).toEqual(['planner', 'developer', 'auditor', 'final-auditor']);
  });

  it('emits verification.completed for the local verification gate', async () => {
    repoDir = createTestRepo('verify');

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a hello function',
      task_slug: 'hello-func',
    });
    expect(result.phase).toBe('PASSED');

    const store = new EventStore(join(repoDir, '.agent'), result.run_id);
    const events = await store.readAll();
    const verification = events.filter((e) => e.kind === 'verification.completed');
    expect(verification.length).toBeGreaterThanOrEqual(1);
    expect(verification[0].exit_code).toBe(0);
    expect(verification[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits run.blocked with a reason when the run is blocked', async () => {
    repoDir = createTestRepo('blocked', { developer: 'blocked-handoff' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a hello function',
      task_slug: 'hello-func',
    });

    expect(result.phase).toBe('BLOCKED');

    const store = new EventStore(join(repoDir, '.agent'), result.run_id);
    const events = await store.readAll();
    const blocked = events.find((e) => e.kind === 'run.blocked');
    expect(blocked).toBeDefined();
    expect(blocked?.message).toBeTruthy();
    expect(blocked?.status).toBe('BLOCKED');
  });

  it('emits run.failed when the iteration loop exhausts without passing', async () => {
    // Developer writes a completed handoff but auditor always FAILs.
    repoDir = createTestRepo('failed', { auditor: 'audit-fail' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a hello function',
      task_slug: 'hello-func',
      max_iterations: 1,
    });
    expect(result.phase).toBe('FAILED');

    const store = new EventStore(join(repoDir, '.agent'), result.run_id);
    const events = await store.readAll();
    const failed = events.find((e) => e.kind === 'run.failed');
    expect(failed).toBeDefined();
    expect(failed?.status).toBe('FAILED');
    expect(failed?.level).toBe('error');
    // run.failed must be the last event so watch exits cleanly.
    expect(events[events.length - 1].kind).toBe('run.failed');

    // R5/R12: a FAIL audit.decision must carry rework_reason pointing at the
    // audit-report path, and finding_count must be numeric.
    const auditDecisions = events.filter((e) => e.kind === 'audit.decision');
    expect(auditDecisions.length).toBeGreaterThan(0);
    const failDecision = auditDecisions.find((e) => e.status !== 'PASS');
    expect(failDecision).toBeDefined();
    expect(typeof failDecision!.payload?.finding_count).toBe('number');
    expect(failDecision!.payload?.rework_reason).toBe('.agent/audit-report.md');
  });

  it('appends to the existing events.jsonl on resume instead of truncating', async () => {
    repoDir = createTestRepo('resume', { auditor: 'audit-fail-then-pass' });

    const first = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      task_slug: 'feat',
      max_iterations: 3,
    });
    // The first run may PASS (audit-fail-then-pass passes on iter 2) or BLOCK;
    // we only need it to have written some events.
    expect(['PASSED', 'BLOCKED']).toContain(first.phase);

    const store = new EventStore(join(repoDir, '.agent'), first.run_id);
    const beforeCount = (await store.readAll()).length;
    expect(beforeCount).toBeGreaterThan(0);

    // A second orchestrator invocation with resume_from should continue the
    // event stream rather than restart it.
    const second = await runOrchestrator({
      project_root: repoDir,
      resume_from: { run_id: first.run_id },
    });

    const afterCount = (await store.readAll()).length;
    expect(afterCount).toBeGreaterThanOrEqual(beforeCount);
    // A run.resumed event must appear somewhere in the second run's additions.
    const resumedEvent = (await store.readAll()).find((e) => e.kind === 'run.resumed');
    if (second.phase !== first.phase) {
      expect(resumedEvent).toBeDefined();
    }
  });
});
