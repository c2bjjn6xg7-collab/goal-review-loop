/**
 * Unit tests for the Phase 10 status-side feedback summary reader.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readFeedbackSummary,
  emptyFeedbackSummary,
  feedbackSummaryHasContent,
  FEEDBACK_BYPRODUCT_PATHS,
} from '../../src/cli/status-feedback-summary.js';

function makeTmpProject(): string {
  const dir = join(
    tmpdir(),
    `status-feedback-summary-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, '.agent'), { recursive: true });
  return dir;
}

function writeAgent(root: string, rel: string, body: string): void {
  writeFileSync(join(root, rel), body, 'utf8');
}

describe('readFeedbackSummary', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpProject();
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('returns the stable empty summary when no byproduct files exist', () => {
    const out = readFeedbackSummary(tmp);
    expect(out).toEqual(emptyFeedbackSummary());
    expect(feedbackSummaryHasContent(out)).toBe(false);
    expect(out.present_files).toEqual([]);
    expect(out.by_type).toEqual({
      clarify: 0,
      followup_task: 0,
      risk_note: 0,
      scope_concern: 0,
      verification_suggestion: 0,
    });
    expect(out.by_role).toEqual({
      planner: 0,
      developer: 0,
      auditor: 0,
      final_auditor: 0,
    });
  });

  it('does not throw when project root does not exist', () => {
    const fake = join(tmp, 'does', 'not', 'exist');
    expect(() => readFeedbackSummary(fake)).not.toThrow();
    const s = readFeedbackSummary(fake);
    expect(s.blocks_total).toBe(0);
    expect(s.parse_warnings).toBe(0);
  });

  it('counts clarify entries and assigns them to the planner role', () => {
    writeAgent(
      tmp,
      FEEDBACK_BYPRODUCT_PATHS.clarifications,
      [
        '## 2026-06-18T10:00:00.000Z | run abc | clarify | line 12',
        'Q: What is X?',
        '',
        '## 2026-06-18T10:01:00.000Z | run abc | clarify (blocking) | line 25',
        'Q: Y?',
        '',
      ].join('\n'),
    );
    const s = readFeedbackSummary(tmp);
    expect(s.by_type.clarify).toBe(2);
    expect(s.by_role.planner).toBe(2);
    expect(s.blocks_total).toBe(2);
    expect(s.unknown_role_blocks).toBe(0);
    expect(s.present_files).toContain(FEEDBACK_BYPRODUCT_PATHS.clarifications);
  });

  it('counts risk_note and scope_concern entries with explicit origin role', () => {
    writeAgent(
      tmp,
      FEEDBACK_BYPRODUCT_PATHS.feedback_notes,
      [
        '### 2026-06-18T10:00:00.000Z | run abc | risk_note | origin auditor | line 5',
        '- message: m',
        '- description: d',
        '',
        '### 2026-06-18T10:01:00.000Z | run abc | scope_concern | origin developer | line 7',
        '- message: m',
        '- description: d',
        '',
        '### 2026-06-18T10:02:00.000Z | run abc | risk_note | origin final_auditor | line 9',
        '- message: m',
        '- description: d',
        '',
        '### 2026-06-18T10:03:00.000Z | run abc | risk_note | origin planner | line 11',
        '- message: m',
        '- description: d',
        '',
      ].join('\n'),
    );
    const s = readFeedbackSummary(tmp);
    expect(s.by_type.risk_note).toBe(3);
    expect(s.by_type.scope_concern).toBe(1);
    expect(s.by_role.auditor).toBe(1);
    expect(s.by_role.developer).toBe(1);
    expect(s.by_role.final_auditor).toBe(1);
    expect(s.by_role.planner).toBe(1);
    expect(s.unknown_role_blocks).toBe(0);
    expect(s.blocks_total).toBe(4);
  });

  it('infers verification_suggestion as developer and treats followup_task as unknown role', () => {
    writeAgent(
      tmp,
      FEEDBACK_BYPRODUCT_PATHS.followups,
      [
        '### 2026-06-18T10:00:00.000Z | run abc | followup_task | line 1',
        '- [ ] **Investigate flaky test**',
        '  - description here',
        '',
        '### 2026-06-18T10:01:00.000Z | run abc | followup_task | line 4',
        '- [ ] **Another**',
        '  - description here',
        '',
        '### 2026-06-18T10:02:00.000Z | run abc | verification_suggestion | line 8',
        '- [ ] **verification_suggestion**',
        '  - reason',
        '  - verify: `npm test`',
        '',
      ].join('\n'),
    );
    const s = readFeedbackSummary(tmp);
    expect(s.by_type.followup_task).toBe(2);
    expect(s.by_type.verification_suggestion).toBe(1);
    expect(s.by_role.developer).toBe(1);
    expect(s.by_role.planner).toBe(0);
    expect(s.unknown_role_blocks).toBe(2);
    expect(s.blocks_total).toBe(3);
  });

  it('counts parse-warnings as a separate metric and does not add them to blocks_total', () => {
    writeAgent(
      tmp,
      FEEDBACK_BYPRODUCT_PATHS.parse_warnings,
      [
        '## 2026-06-18T10:00:00.000Z | run abc | planner | .agent/plan.md',
        '- line 12: YAML: bad mapping',
        '  ```',
        '  raw',
        '  ```',
        '',
        '## 2026-06-18T10:01:00.000Z | run abc | developer | .agent/developer-handoff.md',
        '- line 5: schema validation failed',
        '  ```',
        '  raw',
        '  ```',
        '',
      ].join('\n'),
    );
    const s = readFeedbackSummary(tmp);
    expect(s.parse_warnings).toBe(2);
    expect(s.blocks_total).toBe(0);
    expect(s.unknown_role_blocks).toBe(0);
    expect(s.present_files).toContain(FEEDBACK_BYPRODUCT_PATHS.parse_warnings);
  });

  it('counts multiple parse-warnings under one header (dispatcher emits N errors per artifact)', () => {
    // Mirrors feedback-dispatcher.ts writeParseWarnings: ONE `##` header per
    // (role, artifact) but MULTIPLE `- line N` bullets when that artifact had
    // several parse errors. Counting headers would underreport.
    writeAgent(
      tmp,
      FEEDBACK_BYPRODUCT_PATHS.parse_warnings,
      [
        '## 2026-06-18T10:00:00.000Z | run abc | planner | .agent/plan.md',
        '- line 12: YAML: bad mapping',
        '  ```',
        '  raw',
        '  ```',
        '- line 47: schema validation failed',
        '  ```',
        '  raw2',
        '  ```',
      ].join('\n'),
    );
    const s = readFeedbackSummary(tmp);
    expect(s.parse_warnings).toBe(2);
    expect(s.blocks_total).toBe(0);
  });

  it('treats empty byproduct files as present but contributing zero counts', () => {
    writeAgent(tmp, FEEDBACK_BYPRODUCT_PATHS.clarifications, '');
    writeAgent(tmp, FEEDBACK_BYPRODUCT_PATHS.feedback_notes, '');
    writeAgent(tmp, FEEDBACK_BYPRODUCT_PATHS.followups, '');
    writeAgent(tmp, FEEDBACK_BYPRODUCT_PATHS.parse_warnings, '');
    const s = readFeedbackSummary(tmp);
    expect(s.blocks_total).toBe(0);
    expect(s.parse_warnings).toBe(0);
    expect(s.present_files.sort()).toEqual([
      FEEDBACK_BYPRODUCT_PATHS.clarifications,
      FEEDBACK_BYPRODUCT_PATHS.feedback_notes,
      FEEDBACK_BYPRODUCT_PATHS.followups,
      FEEDBACK_BYPRODUCT_PATHS.parse_warnings,
    ].sort());
    expect(feedbackSummaryHasContent(s)).toBe(true);
  });

  it('ignores malformed and non-matching markdown lines without throwing', () => {
    writeAgent(
      tmp,
      FEEDBACK_BYPRODUCT_PATHS.clarifications,
      [
        '## not a clarify header at all',
        '# heading-only line',
        'random body text',
        '',
        '## 2026-06-18T10:00:00.000Z | run abc | clarify | line 1',
        'Q: well-formed clarify',
        '',
        '## ts | run abc | not_a_type | line 1',
        '',
      ].join('\n'),
    );
    writeAgent(
      tmp,
      FEEDBACK_BYPRODUCT_PATHS.feedback_notes,
      [
        '### 2026-06-18T10:00:00.000Z | run abc | risk_note | line 5',
        // ^ missing `origin <role>` segment → must be ignored
        '- message: m',
        '',
        '### 2026-06-18T10:01:00.000Z | run abc | not_a_known_type | origin auditor | line 6',
        '- message: m',
        '',
      ].join('\n'),
    );
    writeAgent(
      tmp,
      FEEDBACK_BYPRODUCT_PATHS.followups,
      [
        'random preamble',
        '## not_a_followup_header_level',
        '### incomplete header without pipe',
        '',
      ].join('\n'),
    );
    const s = readFeedbackSummary(tmp);
    expect(s.by_type.clarify).toBe(1);
    expect(s.by_type.risk_note).toBe(0);
    expect(s.by_type.followup_task).toBe(0);
    expect(s.unknown_role_blocks).toBe(0);
    expect(s.blocks_total).toBe(1);
  });

  it('produces a JSON-serializable result with a stable schema', () => {
    writeAgent(
      tmp,
      FEEDBACK_BYPRODUCT_PATHS.clarifications,
      '## 2026-06-18T10:00:00.000Z | run abc | clarify | line 1\nQ: A?\n',
    );
    writeAgent(
      tmp,
      FEEDBACK_BYPRODUCT_PATHS.parse_warnings,
      '## 2026-06-18T10:00:00.000Z | run abc | auditor | .agent/audit-report.md\n- line 1: bad\n',
    );
    const s = readFeedbackSummary(tmp);
    const json = JSON.parse(JSON.stringify(s));
    expect(Object.keys(json).sort()).toEqual(
      [
        'blocks_total',
        'by_role',
        'by_type',
        'parse_warnings',
        'present_files',
        'unknown_role_blocks',
      ].sort(),
    );
    expect(Object.keys(json.by_type).sort()).toEqual(
      ['clarify', 'followup_task', 'risk_note', 'scope_concern', 'verification_suggestion'].sort(),
    );
    expect(Object.keys(json.by_role).sort()).toEqual(
      ['auditor', 'developer', 'final_auditor', 'planner'].sort(),
    );
    expect(typeof json.blocks_total).toBe('number');
    expect(typeof json.parse_warnings).toBe('number');
    expect(Array.isArray(json.present_files)).toBe(true);
  });

  it('makes feedbackSummaryHasContent true once any byproduct file exists', () => {
    expect(feedbackSummaryHasContent(emptyFeedbackSummary())).toBe(false);
    writeAgent(tmp, FEEDBACK_BYPRODUCT_PATHS.parse_warnings, '');
    const s = readFeedbackSummary(tmp);
    expect(feedbackSummaryHasContent(s)).toBe(true);
  });

  it('aggregates counts across all four byproduct files in one read', () => {
    writeAgent(
      tmp,
      FEEDBACK_BYPRODUCT_PATHS.clarifications,
      '## ts | run r | clarify | line 1\nQ: A?\n',
    );
    writeAgent(
      tmp,
      FEEDBACK_BYPRODUCT_PATHS.feedback_notes,
      '### ts | run r | risk_note | origin developer | line 2\n- message: m\n- description: d\n',
    );
    writeAgent(
      tmp,
      FEEDBACK_BYPRODUCT_PATHS.followups,
      '### ts | run r | verification_suggestion | line 3\n- [ ] **v**\n  - reason\n',
    );
    writeAgent(
      tmp,
      FEEDBACK_BYPRODUCT_PATHS.parse_warnings,
      '## ts | run r | planner | .agent/plan.md\n- line 1: oops\n',
    );
    const s = readFeedbackSummary(tmp);
    expect(s.blocks_total).toBe(3);
    expect(s.parse_warnings).toBe(1);
    expect(s.by_type.clarify).toBe(1);
    expect(s.by_type.risk_note).toBe(1);
    expect(s.by_type.verification_suggestion).toBe(1);
    expect(s.by_role.planner).toBe(1);
    expect(s.by_role.developer).toBe(2); // risk_note origin + verification_suggestion inferred
    expect(s.unknown_role_blocks).toBe(0);
    expect(s.present_files).toEqual(
      [
        FEEDBACK_BYPRODUCT_PATHS.clarifications,
        FEEDBACK_BYPRODUCT_PATHS.feedback_notes,
        FEEDBACK_BYPRODUCT_PATHS.followups,
        FEEDBACK_BYPRODUCT_PATHS.parse_warnings,
      ].sort(),
    );
  });
});
