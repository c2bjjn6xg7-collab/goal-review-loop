import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { dispatchFeedbackBlocks, readClarificationsForPlanner } from '../../src/orchestrator/feedback-dispatcher.js';
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

describe('feedback-dispatcher', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-dispatch-'));
  });
  afterEach(async () => {
    await fs.remove(tmp);
  });

  it('parses blocks and writes feedback-notes.md for an auditor risk_note', async () => {
    const artifact = path.join(tmp, '.agent', 'audit-report.md');
    await fs.outputFile(artifact, '```ReviewLoopRequest\ntype: risk_note\norigin_agent: auditor\nmessage: m\ncategory: race_condition\ndescription: writers race\nmitigation_hint: mutex\n```');
    const res = await dispatchFeedbackBlocks({
      projectRoot: tmp, runId: 'r1', role: 'auditor', artifactPath: artifact, config: defaultConfig(),
    });
    expect(res.blocks_accepted).toBe(1);
    expect(res.blocks_rejected).toBe(0);
    expect(res.notes_written).toBe(1);
    expect(res.followups_written).toBe(0);
    const notesContent = await fs.readFile(path.join(tmp, '.agent/feedback-notes.md'), 'utf8');
    expect(notesContent).toContain('risk_note');
    expect(notesContent).toContain('writers race');
    expect(fs.existsSync(path.join(tmp, '.agent/followups.md'))).toBe(false);
  });

  it('writes a clarification to clarifications.md for planner clarify', async () => {
    const artifact = path.join(tmp, '.agent', 'plan.md');
    await fs.outputFile(artifact, '```ReviewLoopRequest\ntype: clarify\norigin_agent: planner\nmessage: m\ntarget: planner\nquestion: what scope?\nblocking: false\n```');
    const res = await dispatchFeedbackBlocks({
      projectRoot: tmp, runId: 'r1', role: 'planner', artifactPath: artifact, config: defaultConfig(),
    });
    expect(res.clarifications_written).toBe(1);
    const clar = await fs.readFile(path.join(tmp, '.agent/clarifications.md'), 'utf8');
    expect(clar).toContain('what scope?');
  });

  it('writes parse-warnings.md for invalid blocks', async () => {
    const artifact = path.join(tmp, '.agent', 'audit-report.md');
    await fs.outputFile(artifact, '```ReviewLoopRequest\ntype: clarify\norigin_agent: auditor\nmessage: m\ntarget: planner\nquestion: q\n```');
    const res = await dispatchFeedbackBlocks({
      projectRoot: tmp, runId: 'r1', role: 'auditor', artifactPath: artifact, config: defaultConfig(),
    });
    expect(res.blocks_accepted).toBe(0);
    expect(res.blocks_rejected).toBe(1);
    const warnings = await fs.readFile(path.join(tmp, '.agent/parse-warnings.md'), 'utf8');
    expect(warnings).toContain('line 1');
  });

  it('does nothing when enabled: false (byte-identical inertness)', async () => {
    const artifact = path.join(tmp, '.agent', 'plan.md');
    await fs.outputFile(artifact, '```ReviewLoopRequest\ntype: clarify\norigin_agent: planner\nmessage: m\ntarget: planner\nquestion: q\n```');
    const res = await dispatchFeedbackBlocks({
      projectRoot: tmp, runId: 'r1', role: 'planner', artifactPath: artifact, config: defaultConfig({ enabled: false }),
    });
    expect(res.blocks_accepted).toBe(0);
    expect(res.clarifications_written).toBe(0);
    expect(res.notes_written).toBe(0);
    expect(fs.existsSync(path.join(tmp, '.agent/clarifications.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, '.agent/followups.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, '.agent/feedback-notes.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, '.agent/parse-warnings.md'))).toBe(false);
  });

  it('never throws on missing artifact', async () => {
    const res = await dispatchFeedbackBlocks({
      projectRoot: tmp, runId: 'r1', role: 'auditor', artifactPath: path.join(tmp, 'missing.md'), config: defaultConfig(),
    });
    expect(res.notes.length).toBeGreaterThan(0);
  });

  it('registers byproduct files in the registry', async () => {
    const artifact = path.join(tmp, '.agent', 'audit-report.md');
    await fs.outputFile(artifact, '```ReviewLoopRequest\ntype: risk_note\norigin_agent: auditor\nmessage: m\ncategory: other\ndescription: d\n```');
    const registered: string[] = [];
    const registry = { register: (fp: string) => registered.push(fp) };
    await dispatchFeedbackBlocks({
      projectRoot: tmp, runId: 'r1', role: 'auditor', artifactPath: artifact, config: defaultConfig(), registry,
    });
    expect(registered.some((p) => p.endsWith('.agent/feedback-notes.md'))).toBe(true);
  });

  it('readClarificationsForPlanner returns empty string when absent', async () => {
    expect(await readClarificationsForPlanner(tmp)).toBe('');
  });
});
