import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import {
  dispatchFeedbackBlocks,
  readFeedbackNotesForAudit,
} from '../../src/orchestrator/feedback-dispatcher.js';
import { buildAuditorPrompt, buildFinalAuditorPrompt, loadPromptTemplate } from '../../src/agents/prompt-builder.js';
import type { FeedbackProtocolConfig } from '../../src/types.js';

function defaultConfig(overrides: Partial<FeedbackProtocolConfig> = {}): FeedbackProtocolConfig {
  return {
    enabled: true,
    self_correction: false,
    max_blocks_per_document: 10,
    allowed_types_per_role: {
      planner: ['clarify', 'risk_note', 'followup_task'],
      developer: ['scope_concern', 'verification_suggestion', 'risk_note', 'followup_task'],
      auditor: ['risk_note', 'followup_task'],
      final_auditor: ['risk_note', 'followup_task'],
    },
    ...overrides,
  };
}

const MINIMAL_AUDITOR_TEMPLATE = `# Auditor
HANDOFF: {{HANDOFF_PATH}}
FEEDBACK_NOTES_PATH: {{FEEDBACK_NOTES_PATH}}
FEEDBACK_NOTES_CONTENT:
{{FEEDBACK_NOTES}}
`;

describe('Phase 10 risk_note audit visibility', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-risk-'));
  });
  afterEach(async () => {
    await fs.remove(tmp);
  });

  it('routes developer risk_note to feedback-notes.md, not followups.md', async () => {
    const artifact = path.join(tmp, '.agent', 'developer-handoff.md');
    await fs.outputFile(
      artifact,
      '```ReviewLoopRequest\ntype: risk_note\norigin_agent: developer\nmessage: race condition in cache\ncategory: race_condition\ndescription: concurrent writes may lose data\nmitigation_hint: add mutex\n```',
    );

    const res = await dispatchFeedbackBlocks({
      projectRoot: tmp,
      runId: 'r1',
      role: 'developer',
      artifactPath: artifact,
      config: defaultConfig(),
    });

    expect(res.blocks_accepted).toBe(1);
    expect(res.notes_written).toBe(1);
    expect(res.followups_written).toBe(0);

    const notesContent = await fs.readFile(path.join(tmp, '.agent/feedback-notes.md'), 'utf8');
    expect(notesContent).toContain('risk_note');
    expect(notesContent).toContain('race condition in cache');
    expect(notesContent).toContain('race_condition');
    expect(notesContent).toContain('concurrent writes may lose data');
    expect(notesContent).toContain('add mutex');

    expect(fs.existsSync(path.join(tmp, '.agent/followups.md'))).toBe(false);
  });

  it('auditor prompt includes feedback notes with anti-incentive language', async () => {
    const artifact = path.join(tmp, '.agent', 'developer-handoff.md');
    await fs.outputFile(
      artifact,
      '```ReviewLoopRequest\ntype: risk_note\norigin_agent: developer\nmessage: unbounded retry\ncategory: performance\ndescription: retry helper has no backoff cap\nmitigation_hint: add max-attempts\n```',
    );

    await dispatchFeedbackBlocks({
      projectRoot: tmp,
      runId: 'r1',
      role: 'developer',
      artifactPath: artifact,
      config: defaultConfig(),
    });

    const feedbackNotes = await readFeedbackNotesForAudit(tmp);
    expect(feedbackNotes).toContain('risk_note');
    expect(feedbackNotes).toContain('unbounded retry');

    const prompt = buildAuditorPrompt(MINIMAL_AUDITOR_TEMPLATE, {
      run_id: 'r1',
      iteration: 1,
      project_root: tmp,
      plan_path: '.agent/plan.md',
      goal_path: '.agent/GOAL.md',
      handoff_path: '.agent/developer-handoff.md',
      verification_manifest_path: '.agent/verification/manifest.json',
      changed_files_path: '.agent/evidence/iteration-01/changed-files.json',
      untracked_files_path: '.agent/evidence/iteration-01/untracked-files.json',
      scope_report_path: '.agent/evidence/iteration-01/scope-report.json',
      tracked_diff_path: '.agent/evidence/iteration-01/tracked.diff',
      diff_metadata_path: '.agent/evidence/iteration-01/diff-metadata.json',
      audit_report_path: '.agent/audit-report.md',
      goal_digest: 'abc',
      diff_digest: 'def',
      feedback_notes: feedbackNotes,
      feedback_notes_path: '.agent/feedback-notes.md',
    });

    expect(prompt).toContain('risk_note');
    expect(prompt).toContain('unbounded retry');
    expect(prompt).toContain('.agent/feedback-notes.md');
  });

  it('auditor prompt falls back to (none) when no feedback notes exist', () => {
    const prompt = buildAuditorPrompt(MINIMAL_AUDITOR_TEMPLATE, {
      run_id: 'r1',
      iteration: 1,
      project_root: '/tmp/test',
      plan_path: '.agent/plan.md',
      goal_path: '.agent/GOAL.md',
      handoff_path: '.agent/developer-handoff.md',
      verification_manifest_path: '.agent/verification/manifest.json',
      changed_files_path: '.agent/evidence/iteration-01/changed-files.json',
      untracked_files_path: '.agent/evidence/iteration-01/untracked-files.json',
      scope_report_path: '.agent/evidence/iteration-01/scope-report.json',
      tracked_diff_path: '.agent/evidence/iteration-01/tracked.diff',
      diff_metadata_path: '.agent/evidence/iteration-01/diff-metadata.json',
      audit_report_path: '.agent/audit-report.md',
      goal_digest: 'abc',
      diff_digest: 'def',
    });

    expect(prompt).toContain('(none)');
    expect(prompt).toContain('.agent/feedback-notes.md');
  });

  it('readFeedbackNotesForAudit returns empty string when file absent', async () => {
    const result = await readFeedbackNotesForAudit(tmp);
    expect(result).toBe('');
  });

  it('routes scope_concern to feedback-notes.md, not followups.md', async () => {
    const artifact = path.join(tmp, '.agent', 'developer-handoff.md');
    await fs.outputFile(
      artifact,
      '```ReviewLoopRequest\ntype: scope_concern\norigin_agent: developer\nmessage: may touch auth module\nrequested_paths:\n  - src/auth/login.ts\nreason: changes could affect login flow\n```',
    );

    const res = await dispatchFeedbackBlocks({
      projectRoot: tmp,
      runId: 'r1',
      role: 'developer',
      artifactPath: artifact,
      config: defaultConfig(),
    });

    expect(res.blocks_accepted).toBe(1);
    expect(res.notes_written).toBe(1);
    expect(res.followups_written).toBe(0);

    const notesContent = await fs.readFile(path.join(tmp, '.agent/feedback-notes.md'), 'utf8');
    expect(notesContent).toContain('scope_concern');
    expect(notesContent).toContain('may touch auth module');

    expect(fs.existsSync(path.join(tmp, '.agent/followups.md'))).toBe(false);
  });

  it('followup_task still goes to followups.md, not feedback-notes.md', async () => {
    const artifact = path.join(tmp, '.agent', 'developer-handoff.md');
    await fs.outputFile(
      artifact,
      '```ReviewLoopRequest\ntype: followup_task\norigin_agent: developer\nmessage: add e2e test\ntitle: e2e coverage\ndescription: need coverage for cache retry\n```',
    );

    const res = await dispatchFeedbackBlocks({
      projectRoot: tmp,
      runId: 'r1',
      role: 'developer',
      artifactPath: artifact,
      config: defaultConfig(),
    });

    expect(res.blocks_accepted).toBe(1);
    expect(res.followups_written).toBe(1);
    expect(res.notes_written).toBe(0);

    expect(fs.existsSync(path.join(tmp, '.agent/followups.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.agent/feedback-notes.md'))).toBe(false);
  });

  it('registers .agent/feedback-notes.md in the registry', async () => {
    const artifact = path.join(tmp, '.agent', 'developer-handoff.md');
    await fs.outputFile(
      artifact,
      '```ReviewLoopRequest\ntype: risk_note\norigin_agent: developer\nmessage: test\ncategory: other\ndescription: d\n```',
    );
    const registered: string[] = [];
    const registry = { register: (fp: string) => registered.push(fp) };

    await dispatchFeedbackBlocks({
      projectRoot: tmp,
      runId: 'r1',
      role: 'developer',
      artifactPath: artifact,
      config: defaultConfig(),
      registry,
    });

    expect(registered.some((p) => p.endsWith('.agent/feedback-notes.md'))).toBe(true);
    expect(registered.some((p) => p.endsWith('.agent/followups.md'))).toBe(false);
  });
});

describe('Phase 10 anti-incentive keyword regression (real templates)', () => {
  const projectRoot = path.resolve(import.meta.dirname ?? __dirname, '..', '..');

  const baseAuditorCtx = {
    run_id: 'r1',
    iteration: 1,
    project_root: projectRoot,
    plan_path: '.agent/plan.md',
    goal_path: '.agent/GOAL.md',
    handoff_path: '.agent/developer-handoff.md',
    verification_manifest_path: '.agent/verification/manifest.json',
    changed_files_path: '.agent/evidence/iteration-01/changed-files.json',
    untracked_files_path: '.agent/evidence/iteration-01/untracked-files.json',
    scope_report_path: '.agent/evidence/iteration-01/scope-report.json',
    tracked_diff_path: '.agent/evidence/iteration-01/tracked.diff',
    diff_metadata_path: '.agent/evidence/iteration-01/diff-metadata.json',
    audit_report_path: '.agent/audit-report.md',
    goal_digest: 'abc',
    diff_digest: 'def',
    feedback_notes: '### risk_note | race condition detected',
    feedback_notes_path: '.agent/feedback-notes.md',
  };

  const baseFinalAuditorCtx = {
    run_id: 'r1',
    iteration: 1,
    project_root: projectRoot,
    plan_path: '.agent/plan.md',
    goal_path: '.agent/GOAL.md',
    handoff_path: '.agent/developer-handoff.md',
    audit_report_path: '.agent/audit-report.md',
    verification_manifest_path: '.agent/verification/manifest.json',
    changed_files_path: '.agent/evidence/iteration-01/changed-files.json',
    untracked_files_path: '.agent/evidence/iteration-01/untracked-files.json',
    scope_report_path: '.agent/evidence/iteration-01/scope-report.json',
    diff_metadata_path: '.agent/evidence/iteration-01/diff-metadata.json',
    final_audit_path: '.agent/final-audit.md',
    goal_digest: 'abc',
    diff_digest: 'def',
    audit_report_digest: 'ghi',
    verification_manifest_digest: 'jkl',
    feedback_notes: '### risk_note | race condition detected',
    feedback_notes_path: '.agent/feedback-notes.md',
  };

  it('auditor prompt contains anti-incentive keywords from real template', async () => {
    const { content: template } = await loadPromptTemplate(projectRoot, 'auditor.md');
    const prompt = buildAuditorPrompt(template, baseAuditorCtx);

    expect(prompt).toMatch(/diligence signal/i);
    expect(prompt).toMatch(/Do [Nn][Oo][Tt] REWORK merely because/i);
    expect(prompt).toMatch(/independen(tly )?verif(y|ication)/i);
  });

  it('final auditor prompt contains anti-incentive keywords from real template', async () => {
    const { content: template } = await loadPromptTemplate(projectRoot, 'final-auditor.md');
    const prompt = buildFinalAuditorPrompt(template, baseFinalAuditorCtx);

    expect(prompt).toMatch(/diligence signal/i);
    expect(prompt).toMatch(/Do [Nn][Oo][Tt] FAIL merely because/i);
    expect(prompt).toMatch(/independen(tly )?verif(y|ication)/i);
  });

  it('auditor prompt injects developer risk_note content from feedback_notes', async () => {
    const { content: template } = await loadPromptTemplate(projectRoot, 'auditor.md');
    const prompt = buildAuditorPrompt(template, baseAuditorCtx);

    expect(prompt).toContain('race condition detected');
    expect(prompt).toContain('.agent/feedback-notes.md');
  });
});
