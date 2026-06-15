import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildFinalAuditorInput, validateFinalAuditorOutput } from '../../src/agents/final-auditor-adapter.js';

describe('buildFinalAuditorInput', () => {
  it('builds input with role final-auditor', () => {
    const input = buildFinalAuditorInput({
      run_id: 'run-001',
      iteration: 1,
      project_root: '/tmp/test',
      command_template: ['node', 'agent.mjs'],
      timeout_seconds: 600,
      prompt: 'test prompt',
    });
    expect(input.role).toBe('final-auditor');
    expect(input.run_id).toBe('run-001');
    expect(input.iteration).toBe(1);
    expect(input.expected_artifacts).toContain('/tmp/test/.agent/final-audit.md');
  });
});

describe('validateFinalAuditorOutput', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'final-audit-test-'));
    mkdirSync(join(tempDir, '.agent'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeFinalAudit(content: string) {
    writeFileSync(join(tempDir, '.agent', 'final-audit.md'), content, 'utf8');
  }

  const validDigest = 'sha256:' + 'a'.repeat(64);

  it('returns valid for correct PASS final-audit', () => {
    writeFinalAudit(`---
schema_version: 1
run_id: "run-001"
author_role: "auditor"
decision: "PASS"
final_iteration: 1
goal_digest: "${validDigest}"
diff_digest: "${validDigest}"
audit_report_digest: "${validDigest}"
verification_manifest_digest: "${validDigest}"
created_at: "2026-06-14T00:00:00.000Z"
---

# Final Audit

All checks passed.
`);
    const result = validateFinalAuditorOutput({
      projectRoot: tempDir,
      runId: 'run-001',
      iteration: 1,
      expectedGoalDigest: validDigest,
      expectedDiffDigest: validDigest,
      expectedAuditReportDigest: validDigest,
      expectedVerificationManifestDigest: validDigest,
    });
    expect(result.valid).toBe(true);
    expect(result.decision).toBe('PASS');
    expect(result.effectiveDecision).toBe('PASS');
  });

  it('returns invalid when final-audit.md is missing', () => {
    const result = validateFinalAuditorOutput({
      projectRoot: tempDir,
      runId: 'run-001',
      iteration: 1,
      expectedGoalDigest: validDigest,
      expectedDiffDigest: validDigest,
      expectedAuditReportDigest: validDigest,
      expectedVerificationManifestDigest: validDigest,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('final-audit.md not found');
  });

  it('returns invalid when run_id does not match', () => {
    writeFinalAudit(`---
schema_version: 1
run_id: "wrong-run"
author_role: "auditor"
decision: "PASS"
final_iteration: 1
goal_digest: "${validDigest}"
diff_digest: "${validDigest}"
audit_report_digest: "${validDigest}"
verification_manifest_digest: "${validDigest}"
created_at: "2026-06-14T00:00:00.000Z"
---

# Final Audit
`);
    const result = validateFinalAuditorOutput({
      projectRoot: tempDir,
      runId: 'run-001',
      iteration: 1,
      expectedGoalDigest: validDigest,
      expectedDiffDigest: validDigest,
      expectedAuditReportDigest: validDigest,
      expectedVerificationManifestDigest: validDigest,
    });
    expect(result.valid).toBe(false);
  });

  it('returns invalid when goal_digest does not match', () => {
    writeFinalAudit(`---
schema_version: 1
run_id: "run-001"
author_role: "auditor"
decision: "PASS"
final_iteration: 1
goal_digest: "sha256:${'b'.repeat(64)}"
diff_digest: "${validDigest}"
audit_report_digest: "${validDigest}"
verification_manifest_digest: "${validDigest}"
created_at: "2026-06-14T00:00:00.000Z"
---

# Final Audit
`);
    const result = validateFinalAuditorOutput({
      projectRoot: tempDir,
      runId: 'run-001',
      iteration: 1,
      expectedGoalDigest: validDigest,
      expectedDiffDigest: validDigest,
      expectedAuditReportDigest: validDigest,
      expectedVerificationManifestDigest: validDigest,
    });
    expect(result.valid).toBe(false);
  });

  it('overrides PASS with FAILED when mechanical checks fail', () => {
    writeFinalAudit(`---
schema_version: 1
run_id: "run-001"
author_role: "auditor"
decision: "PASS"
final_iteration: 1
goal_digest: "sha256:${'b'.repeat(64)}"
diff_digest: "${validDigest}"
audit_report_digest: "${validDigest}"
verification_manifest_digest: "${validDigest}"
created_at: "2026-06-14T00:00:00.000Z"
---

# Final Audit
`);
    const result = validateFinalAuditorOutput({
      projectRoot: tempDir,
      runId: 'run-001',
      iteration: 1,
      expectedGoalDigest: validDigest,
      expectedDiffDigest: validDigest,
      expectedAuditReportDigest: validDigest,
      expectedVerificationManifestDigest: validDigest,
    });
    expect(result.valid).toBe(false);
    expect(result.effectiveDecision).toBe('FAILED');
  });

  it('returns FAILED decision without override', () => {
    writeFinalAudit(`---
schema_version: 1
run_id: "run-001"
author_role: "auditor"
decision: "FAILED"
final_iteration: 1
goal_digest: "${validDigest}"
diff_digest: "${validDigest}"
audit_report_digest: "${validDigest}"
verification_manifest_digest: "${validDigest}"
created_at: "2026-06-14T00:00:00.000Z"
---

# Final Audit
`);
    const result = validateFinalAuditorOutput({
      projectRoot: tempDir,
      runId: 'run-001',
      iteration: 1,
      expectedGoalDigest: validDigest,
      expectedDiffDigest: validDigest,
      expectedAuditReportDigest: validDigest,
      expectedVerificationManifestDigest: validDigest,
    });
    expect(result.valid).toBe(true);
    expect(result.decision).toBe('FAILED');
  });

  it('returns invalid when iteration does not match', () => {
    writeFinalAudit(`---
schema_version: 1
run_id: "run-001"
author_role: "auditor"
decision: "PASS"
final_iteration: 99
goal_digest: "${validDigest}"
diff_digest: "${validDigest}"
audit_report_digest: "${validDigest}"
verification_manifest_digest: "${validDigest}"
created_at: "2026-06-14T00:00:00.000Z"
---

# Final Audit
`);
    const result = validateFinalAuditorOutput({
      projectRoot: tempDir,
      runId: 'run-001',
      iteration: 1,
      expectedGoalDigest: validDigest,
      expectedDiffDigest: validDigest,
      expectedAuditReportDigest: validDigest,
      expectedVerificationManifestDigest: validDigest,
    });
    expect(result.valid).toBe(false);
  });
});
