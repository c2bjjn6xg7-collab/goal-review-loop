import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  createIntegrationAuditFixture,
  readFixtureJson,
  runFixtureIntegrationAudit,
  type IntegrationAuditFixture,
} from '../helpers/integration-audit-fixture.js';

describe('runIntegrationAudit', () => {
  let fixture: IntegrationAuditFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it('recomputes integrated digest and does not reuse per-task diff_digest evidence', async () => {
    const perTaskDigest = 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff';
    fixture = await createIntegrationAuditFixture({
      suffix: 'digest',
      perTaskDiffDigest: perTaskDigest,
    });

    const result = await runFixtureIntegrationAudit(fixture);

    expect(result.status).toBe('passed');
    expect(result.audit_decision).toBe('PASS');
    expect(result.integrated_diff_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.integrated_diff_digest).not.toBe(perTaskDigest);

    const metadata = readFixtureJson<{
      integrated_diff_digest: string;
      integration_branch: string;
      integration_head: string;
      changed_files: string[];
    }>(fixture, '.agent/integration/integrated-diff-metadata.json');
    expect(metadata.integrated_diff_digest).toBe(result.integrated_diff_digest);
    expect(metadata.integration_branch).toBe(fixture.integrationBranch);
    expect(metadata.integration_head).toBe(fixture.integrationHead);
    expect(metadata.changed_files).toContain('src/feature.ts');

    const contextText = JSON.stringify(
      readFixtureJson<unknown>(fixture, '.agent/integration/final-audit-context.json'),
    );
    expect(contextText).toContain(result.integrated_diff_digest ?? '');
    expect(contextText).toContain('"per_task_diff_digest_reused":false');
    expect(contextText).not.toContain(perTaskDigest);
    expect(contextText).not.toContain('diff_digest":"sha256:1111');

    const finalAudit = path.join(fixture.repoDir, '.agent/final-audit.md');
    expect(existsSync(finalAudit)).toBe(true);
    const state = readFixtureJson<{ audited_diff_digest: string; commit_skipped: boolean; tag_created: boolean }>(
      fixture,
      '.agent/state.json',
    );
    expect(state.audited_diff_digest).toBe(result.integrated_diff_digest);
    expect(state.commit_skipped).toBe(true);
    expect(state.tag_created).toBe(false);
  });
});
