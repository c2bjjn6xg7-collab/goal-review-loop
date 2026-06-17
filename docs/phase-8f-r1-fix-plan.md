# Phase 8F-R1 Fix Plan

## Source

- Requirements: `docs/phase-8f-r1-provider-launch-hardening.md`
- Test report: `docs/phase-8f-r1-plugin-test-report.md`
- Test run ID: `20260617055023-8x5fle`

## Objective

Fix the blocking and high-priority issues found when the Phase 8F-R1 requirements document was fed to the Review Loop plugin via `review-loop start --request-file`. The goal is to make a default `review-loop start` runnable end-to-end with Codex and Claude on this machine without hand-writing fragile shell snippets.

## Fixes

### FIX-1 (P0): Add `-s workspace-write` to all Codex agent commands

**Problem**: `DEFAULT_CONFIG` Codex commands lack the `-s workspace-write` flag. Codex CLI defaults to `read-only` sandbox, blocking all file writes. Planner generates correct content but cannot write `plan.md` or `GOAL.md`.

**Files**:
- `src/artifacts/config.ts` — `DEFAULT_CONFIG` (line ~148)
- `src/providers/builtin-providers.ts` — `codex` builtin profile `command_template` (line ~29)

**Root cause**: `DEFAULT_CONFIG.agents.planner.command` is `['codex', 'exec', '{prompt_file}']`. The `-s workspace-write` flag was documented as required in `review-loop-test-report.md` problem #3 but never applied to built-in defaults.

**Fix**: Change every Codex command to include `-s` and `workspace-write`:

```typescript
// DEFAULT_CONFIG — planner, auditor, final_auditor
command: ['codex', 'exec', '-s', 'workspace-write', '{prompt_file}']

// builtin-providers.ts — codex command_template
command_template: ['codex', 'exec', '-s', 'workspace-write', '{prompt_file}']
```

**Test**: Add a unit test asserting `DEFAULT_CONFIG.agents.planner.command` contains `'-s'` and `'workspace-write'`. Add the same assertion for auditor and final_auditor. Add an assertion that the builtin codex profile `command_template` contains them.

**Acceptance**: `review-loop start` with no `review-loop.yaml` reaches DEVELOPING phase without Planner write failures.

---

### FIX-2 (P0): Ship a dogfood-safe `review-loop.yaml`

**Problem**: The repo has no `review-loop.yaml`. Users fall back to `DEFAULT_CONFIG` which (even after FIX-1) uses the unsafe Claude stdin+login-shell developer pattern. Phase 8F-R1 explicitly flags this as wrong.

**Files**:
- New file: `review-loop.yaml` (repo root)

**Root cause**: No config file exists. `loadConfigWithDefaults` returns `DEFAULT_CONFIG` when `review-loop.yaml` is absent.

**Fix**: Create `review-loop.yaml` with:
- Codex planner/auditor/final_auditor using `-s workspace-write`
- Claude developer using the dogfood-safe argv pattern with proxy stripping and non-login shell:

```yaml
version: 1

agents:
  planner:
    command: ["codex", "exec", "-s", "workspace-write", "{prompt_file}"]
    timeout_seconds: 1800
  developer:
    command:
      - "sh"
      - "-c"
      - 'P=$(cat "$1"); exec env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy claude -p --permission-mode bypassPermissions --max-turns 160 -- "$P"'
      - "claude-developer"
      - "{prompt_file}"
    timeout_seconds: 3600
  auditor:
    command: ["codex", "exec", "-s", "workspace-write", "{prompt_file}"]
    timeout_seconds: 1800
  final_auditor:
    command: ["codex", "exec", "-s", "workspace-write", "{prompt_file}"]
    timeout_seconds: 1800

providers:
  claude:
    enabled: true
    network:
      proxy_mode: none
  codex:
    enabled: true
    network:
      proxy_mode: inherit

loop:
  max_iterations: 3
  archive_history: true
  stop_on_infrastructure_error: true

git:
  require_repository: true
  require_head: true
  require_clean_worktree: true
  branch_template: "agent/{run_id}-{task_slug}"
  commit_on_pass: true
  commit_template: "feat(agent): complete {task_slug} [{run_id}]"
  create_tag: false
  tag_template: "agent-{run_id}-pass"
  push: false

runtime:
  kill_grace_seconds: 10
  max_log_bytes: 10485760
  lock_stale_seconds: 86400
```

**Notes**:
- The Claude developer command uses `sh -c` (non-login) to avoid `.zshrc` reintroducing proxy vars.
- `env -u` strips proxy vars before launching claude.
- `--` before `"$P"` prevents `---` YAML front matter from being parsed as a CLI option.
- `proxy_mode: none` on the claude provider provides a second layer of proxy stripping via Phase 8F.
- `proxy_mode: inherit` on codex preserves the parent shell proxy so Codex can reach the domestic gateway or official API via `127.0.0.1:7897`.
- No API keys, tokens, or gateway URLs in this file.

**Test**: Add a unit test that loads `review-loop.yaml` from the repo root via `loadConfig` and asserts it parses without error.

**Acceptance**: `review-loop start` in this repo uses the shipped config, not `DEFAULT_CONFIG`.

---

### FIX-3 (P1): Fix `TimeoutNaNWarning`

**Problem**: `TimeoutNaNWarning: NaN is not a number. Timeout duration was set to 1.` appears at run start.

**Files**:
- `src/runtime/process-runner.ts` — `setTimeout(..., input.timeout_ms)` at lines ~528 and ~781
- `src/agents/agent-adapter.ts` — `timeout_ms: input.timeout_seconds * 1000` at line ~249

**Root cause**: `input.timeout_ms` reaches `setTimeout` as NaN. The most likely path: `kill_grace_seconds` or `timeout_seconds` is undefined somewhere in the config-to-agent-input chain, and `undefined * 1000` produces NaN. The process runner passes NaN directly to `setTimeout` without guarding.

**Fix**: Add NaN guards in `runProcess` and `runProcessRaw`:

```typescript
// At the top of runProcess / runProcessRaw, after computing timeout
const timeoutMs = Number.isNaN(input.timeout_ms) || input.timeout_ms <= 0
  ? 30 * 60 * 1000  // 30 min fallback
  : input.timeout_ms;
```

Also trace and fix the source of the NaN. Check `buildPlannerInput` and the orchestrator call sites to ensure `timeout_seconds` is always a valid number from config. If `config.agents.planner.timeout_seconds` can be undefined, add a default in `loadConfig`.

**Test**: Add a unit test that calls `runProcess` with `timeout_ms: NaN` and asserts it does not throw and uses a fallback timeout.

**Acceptance**: No `TimeoutNaNWarning` in stderr during `review-loop start`.

---

### FIX-4 (P1): Fix misleading "Planner completed" progress event

**Problem**: Orchestrator emits `lastEvent: 'Planner completed'` (line 423) unconditionally before checking whether the Planner actually succeeded (line 442). When the Planner fails, progress.json briefly shows "completed" then transitions to BLOCKED, which is misleading.

**Files**:
- `src/orchestrator/run-orchestrator.ts` — lines ~420-445

**Root cause**: The `emitProgress` call at line 423 runs before the `status !== 'success'` check at line 442.

**Fix**: Move the "Planner completed" progress event to after the success/failure check, or change it to "Planner finished" and emit a separate "Planner succeeded" or "Planner failed" event based on status:

```typescript
// After line 420 (transcript emit), remove the unconditional "Planner completed"
// Replace with status-aware events:
if (plannerResult.result.status === 'cancelled') {
  await emitProgress({ ..., lastEvent: 'Planner cancelled' });
  // ... existing cancel handling
} else if (plannerResult.result.status !== 'success') {
  await emitProgress({ ..., lastEvent: 'Planner failed' });
  // ... existing failure handling
} else {
  await emitProgress({ ..., lastEvent: 'Planner completed' });
  // ... continue to validation
}
```

**Test**: Add a unit test that runs the orchestrator with a fake Planner that exits 0 but produces stale artifacts, and asserts `progress.json` never records "Planner completed" — it should record "Planner failed".

**Acceptance**: When Planner fails, progress.json shows "Planner failed", never "Planner completed".

---

### FIX-5 (P1): Verify Planner artifact freshness actually catches stale files

**Problem**: `verifyArtifactFreshness` exists in `agent-adapter.ts` (line 397) and should detect stale artifacts (digest unchanged from pre-call). But the test run was interrupted before this check could execute, so it is unverified for the Codex-read-only-sandbox scenario.

**Files**:
- `src/agents/agent-adapter.ts` — lines ~323-410
- `src/agents/planner-adapter.ts` — `PLANNER_ARTIFACTS` and `expected_artifacts` (line 40)

**Root cause**: Unverified. The freshness check logic appears correct: it records pre-call digests, then checks if digests changed. If Codex exits 0 without writing, the digest should be unchanged and the check should return a "stale" violation. However, this path was not exercised to completion in the test run.

**Fix**: No code change required if the check works correctly. However, add a dedicated integration test:

1. Create a temp git repo with pre-existing `.agent/plan.md` and `.agent/GOAL.md`.
2. Run a fake Planner that exits 0 without modifying those files.
3. Assert `runAgent` returns `status: 'failed'` with `ARTIFACT_ERROR` and a "stale" message.

If the test reveals the check does NOT catch this case, investigate whether `recordPreCallState` correctly handles files that exist before the call, and whether the digest comparison logic in `verifyArtifactFreshness` handles the "existed before, unchanged" path.

**Acceptance**: A Planner that exits 0 without writing fresh artifacts is detected and reported as failed, not success.

---

## Non-Goals

- Do not implement Phase 8F-R1's full provider launch hardening (argv transport, shell_mode field, providers test smoke). This fix plan only addresses the blocking issues found during plugin testing.
- Do not implement multi-worker, task graph, or model routing.
- Do not push to remote.

## Verification

After all fixes:

1. `npm run typecheck`
2. `npm run lint`
3. `npm run build`
4. `npm test`
5. `npm audit --omit=dev`
6. `npm pack --dry-run`
7. `git diff --check`
8. `review-loop start --request-file docs/phase-8f-r1-provider-launch-hardening.md --task-slug fix-verification --no-commit --watch` — must reach DEVELOPING phase without Planner write failures or `TimeoutNaNWarning`.

## Priority Order

1. FIX-1 (blocking, 5 min)
2. FIX-2 (blocking, 10 min)
3. FIX-3 (warning, 15 min)
4. FIX-4 (misleading state, 10 min)
5. FIX-5 (verification, 15 min)
