import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  createIntegrationAuditFixture,
  readFixtureJson,
  runFixtureIntegrationAudit,
  type IntegrationAuditFixture,
} from '../helpers/integration-audit-fixture.js';

describe('Phase 8E R2 integration audit failure paths', () => {
  let fixture: IntegrationAuditFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it('blocks on GOAL-level scope violations before verification', async () => {
    fixture = await createIntegrationAuditFixture({
      suffix: 'scope-fail',
      allowedChanges: ['tests/**'],
    });

    const result = await runFixtureIntegrationAudit(fixture);

    expect(result.status).toBe('blocked');
    expect(result.error_code).toBe('SCOPE_VIOLATION');
    expect(result.error_message).toMatch(/Integrated scope violation/);
    expect(existsSync(path.join(fixture.repoDir, '.agent/integration/scope-report.json'))).toBe(true);
    expect(existsSync(path.join(fixture.repoDir, '.agent/integration/verification-manifest.json'))).toBe(false);
    expect(existsSync(path.join(fixture.repoDir, '.agent/final-audit.md'))).toBe(false);

    const scope = readFixtureJson<{ denied: Array<{ path: string }> }>(
      fixture,
      '.agent/integration/scope-report.json',
    );
    expect(scope.denied.map((entry) => entry.path)).toContain('src/feature.ts');
  });

  it('blocks on GOAL-level verification failures before Final Aggregate Audit', async () => {
    fixture = await createIntegrationAuditFixture({
      suffix: 'verification-fail',
      verificationCommand: ['node', '-e', 'process.exit(7)'],
    });

    const result = await runFixtureIntegrationAudit(fixture);

    expect(result.status).toBe('blocked');
    expect(result.error_code).toBe('VERIFICATION_FAILED');
    expect(result.error_message).toMatch(/Integrated verification failed/);
    expect(existsSync(path.join(fixture.repoDir, '.agent/integration/verification-manifest.json'))).toBe(true);
    expect(existsSync(path.join(fixture.repoDir, '.agent/integration/final-audit-context.json'))).toBe(false);
    expect(existsSync(path.join(fixture.repoDir, '.agent/final-audit.md'))).toBe(false);
  });

  it('blocks on Final Aggregate Audit FAILED without creating final commit or tag', async () => {
    fixture = await createIntegrationAuditFixture({
      suffix: 'final-audit-fail',
      finalAuditorBehavior: 'audit-fail',
    });

    const result = await runFixtureIntegrationAudit(fixture);

    expect(result.status).toBe('blocked');
    expect(result.error_code).toBe('FINAL_AUDIT_FAILED');
    expect(result.audit_decision).toBe('FAILED');
    expect(existsSync(path.join(fixture.repoDir, '.agent/final-audit.md'))).toBe(true);

    const state = readFixtureJson<{
      final_commit_sha: string | null;
      tag_created: boolean;
      commit_skipped: boolean;
    }>(fixture, '.agent/state.json');
    expect(state.final_commit_sha).toBeNull();
    expect(state.tag_created).toBe(false);
    expect(state.commit_skipped).toBe(false);
  });
});
