/**
 * Unit tests for rework-instructions module.
 * Phase 4 §7: Build, write, parse, and finding builders.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildReworkInstructions,
  parseReworkInstructions,
  buildReworkFindingsFromScope,
  buildReworkFindingsFromVerification,
  buildReworkFindingsFromAudit,
  resetFindingCounter,
  type BuildReworkInstructionsParams,
} from '../../src/orchestrator/rework-instructions.js';
import type { ReworkFinding, ScopeReportV2, VerificationManifest } from '../../src/types.js';

describe('buildReworkInstructions', () => {
  const baseParams: BuildReworkInstructionsParams = {
    run_id: 'run-001',
    iteration: 2,
    source: 'verification',
    findings: [],
    goal_path: '/project/.agent/GOAL.md',
    evidence_paths: ['/project/.agent/evidence/iteration-01/scope-report.json'],
    verification_commands: ['npm test'],
    project_root: '/project',
  };

  it('builds valid rework instructions with front matter', () => {
    const result = buildReworkInstructions(baseParams);
    expect(result).toContain('schema_version: 1');
    expect(result).toContain('run_id: run-001');
    expect(result).toContain('iteration: 2');
    expect(result).toContain('author_role: orchestrator');
    expect(result).toContain('source: verification');
    expect(result).toContain('status: REWORK_REQUIRED');
    expect(result).toContain('# Rework Instructions');
  });

  it('includes findings in the body', () => {
    const findings: ReworkFinding[] = [{
      id: 'R-001',
      severity: 'critical',
      source: 'verification',
      path: 'npm test',
      evidence: 'Command failed',
      required_fix: 'Fix the test',
      command_id: 'unit-tests',
      argv: ['npm', 'test'],
      exit_code: 1,
      timed_out: false,
    }];
    const result = buildReworkInstructions({ ...baseParams, findings });
    expect(result).toContain('R-001');
    expect(result).toContain('critical');
    expect(result).toContain('Fix the test');
  });

  it('includes evidence paths', () => {
    const result = buildReworkInstructions({
      ...baseParams,
      evidence_paths: ['/project/.agent/evidence/iteration-01/scope-report.json'],
    });
    expect(result).toContain('scope-report.json');
  });

  it('includes verification commands', () => {
    const result = buildReworkInstructions({
      ...baseParams,
      verification_commands: ['npm test', 'npm run lint'],
    });
    expect(result).toContain('npm test');
    expect(result).toContain('npm run lint');
  });

  it('handles empty findings gracefully', () => {
    const result = buildReworkInstructions({ ...baseParams, findings: [] });
    expect(result).toContain('(none)');
  });
});

describe('parseReworkInstructions', () => {
  it('parses valid rework instructions', () => {
    const content = buildReworkInstructions({
      run_id: 'run-002',
      iteration: 2,
      source: 'audit',
      findings: [],
      goal_path: '/project/.agent/GOAL.md',
      evidence_paths: [],
      verification_commands: [],
      project_root: '/project',
    });
    const result = parseReworkInstructions(content);
    expect(result.valid).toBe(true);
    expect(result.frontMatter).not.toBeNull();
    expect(result.frontMatter!.run_id).toBe('run-002');
    expect(result.frontMatter!.iteration).toBe(2);
    expect(result.frontMatter!.source).toBe('audit');
    expect(result.errors).toHaveLength(0);
  });

  it('rejects missing required fields', () => {
    const content = `---
schema_version: 1
run_id: "run-003"
---

# Missing fields
`;
    const result = parseReworkInstructions(content);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects wrong author_role', () => {
    const content = `---
schema_version: 1
run_id: "run-004"
iteration: 2
author_role: "developer"
source: "audit"
status: "REWORK_REQUIRED"
---

# Wrong author
`;
    const result = parseReworkInstructions(content);
    expect(result.valid).toBe(false);
  });

  it('rejects iteration < 2', () => {
    const content = `---
schema_version: 1
run_id: "run-005"
iteration: 1
author_role: "orchestrator"
source: "audit"
status: "REWORK_REQUIRED"
---

# Bad iteration
`;
    const result = parseReworkInstructions(content);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('>= 2'))).toBe(true);
  });

  it('handles malformed YAML', () => {
    const result = parseReworkInstructions('not valid yaml at all {{{');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('buildReworkFindingsFromScope', () => {
  beforeEach(() => {
    resetFindingCounter();
  });

  it('converts scope denials to findings', () => {
    const report: ScopeReportV2 = {
      schema_version: 2,
      passed: false,
      allowed: ['src/test.ts'],
      excluded_orchestrator_owned: ['.agent/state.json'],
      excluded_dependency_cache: ['node_modules/.cache'],
      denied: [
        { path: '.agent/state.json', reason: 'system_protected' },
        { path: 'config/prod.json', reason: 'disallowed_change' },
      ],
      warnings: [],
    };
    const findings = buildReworkFindingsFromScope(report, 1, '/project');
    expect(findings).toHaveLength(2);
    expect(findings[0].source).toBe('scope');
    expect(findings[0].severity).toBe('high');
    expect(findings[0].denial_reason).toBe('system_protected');
    expect(findings[1].denial_reason).toBe('disallowed_change');
  });

  it('returns empty array when no denials', () => {
    const report: ScopeReportV2 = {
      schema_version: 2,
      passed: true,
      allowed: ['src/test.ts'],
      excluded_orchestrator_owned: [],
      excluded_dependency_cache: [],
      denied: [],
      warnings: [],
    };
    const findings = buildReworkFindingsFromScope(report, 1, '/project');
    expect(findings).toHaveLength(0);
  });
});

describe('buildReworkFindingsFromVerification', () => {
  beforeEach(() => {
    resetFindingCounter();
  });

  it('converts failed required commands to findings', () => {
    const manifest: VerificationManifest = {
      schema_version: 1,
      run_id: 'run-001',
      iteration: 1,
      passed: false,
      started_at: '2026-06-13T10:00:00.000Z',
      finished_at: '2026-06-13T10:01:00.000Z',
      commands: [
        { id: 'unit-tests', argv: ['npm', 'test'], cwd: '.', required: true, status: 'failed', exit_code: 1, timed_out: false, duration_ms: 5000, stdout_path: '.agent/verification/iteration-01/unit-tests.stdout', stderr_path: '.agent/verification/iteration-01/unit-tests.stderr', log_io_error: undefined },
        { id: 'lint', argv: ['npm', 'run', 'lint'], cwd: '.', required: false, status: 'success', exit_code: 0, timed_out: false, duration_ms: 2000, stdout_path: '.agent/verification/iteration-01/lint.stdout', stderr_path: '.agent/verification/iteration-01/lint.stderr', log_io_error: undefined },
      ],
    };
    const findings = buildReworkFindingsFromVerification(manifest, 1);
    expect(findings).toHaveLength(1);
    expect(findings[0].source).toBe('verification');
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].command_id).toBe('unit-tests');
    expect(findings[0].exit_code).toBe(1);
  });

  it('ignores non-required failed commands', () => {
    const manifest: VerificationManifest = {
      schema_version: 1,
      run_id: 'run-001',
      iteration: 1,
      passed: true,
      started_at: '2026-06-13T10:00:00.000Z',
      finished_at: '2026-06-13T10:01:00.000Z',
      commands: [
        { id: 'lint', argv: ['npm', 'run', 'lint'], cwd: '.', required: false, status: 'failed', exit_code: 1, timed_out: false, duration_ms: 2000, stdout_path: '.agent/verification/iteration-01/lint.stdout', stderr_path: '.agent/verification/iteration-01/lint.stderr', log_io_error: undefined },
      ],
    };
    const findings = buildReworkFindingsFromVerification(manifest, 1);
    expect(findings).toHaveLength(0);
  });
});

describe('buildReworkFindingsFromAudit', () => {
  beforeEach(() => {
    resetFindingCounter();
  });

  it('extracts structured findings from audit report', () => {
    const auditContent = `# Audit Report

## Findings

### F-001 - High - Test failure

- Evidence: test output
- Impact: Tests do not pass
- Required fix: Fix the test

### F-002 - Medium - Code style issue

- Evidence: lint output
- Impact: Style inconsistency
- Required fix: Run formatter
`;
    const findings = buildReworkFindingsFromAudit(auditContent, 1);
    expect(findings).toHaveLength(2);
    expect(findings[0].source).toBe('audit');
    expect(findings[0].severity).toBe('high');
    expect(findings[1].severity).toBe('medium');
  });

  it('creates generic finding when no structured findings found', () => {
    const auditContent = `# Audit Report

No structured findings here.
`;
    const findings = buildReworkFindingsFromAudit(auditContent, 1);
    expect(findings).toHaveLength(1);
    expect(findings[0].source).toBe('audit');
    expect(findings[0].evidence).toContain('audit-report.md');
  });
});
