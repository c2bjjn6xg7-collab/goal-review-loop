---
schema_version: 1
run_id: phase6-dev
iteration: 1
author_role: developer
status: COMPLETED
---

# Phase 6 Developer Handoff — Iteration 1 + Rework (F-601 through F-604)

## Summary

Phase 6 transforms `review-loop` from a standalone CLI into a Codex-callable Plugin/Skill with Provider abstraction, real-time progress, transcripts, and `--watch` mode. All 12 acceptance criteria from the Phase 6 requirements document are addressed. An initial implementation was reviewed and 4 findings (F-601 through F-604) were fixed in a rework pass.

## Implementation Overview

### Layer 1: Provider Profile System

New files:
- `src/providers/builtin-providers.ts` — 4 built-in providers (claude, codex, codebuddy, opencode)
- `src/providers/provider-registry.ts` — `createProviderRegistry()`, `resolveCommandForAgent()`, health checks
- `src/providers/permission-guard.ts` — Detects `--dangerously-skip-permissions` and `bypassPermissions` in resolved commands

Changes:
- `src/types.ts` — Added `ProviderProfile`, `ProviderConfig`, `ProgressData`, `TranscriptEntry`; extended `AgentConfig` with optional `provider` field; extended `ReviewLoopConfig` with optional `providers` map
- `src/artifacts/config.ts` — Schema extended with `providers` block and `agentConfig.provider` field
- `src/orchestrator/run-orchestrator.ts` — All 4 agent call sites use `resolveCommandForAgent()`

### Layer 2: Progress + Transcript Runtime Output

New files:
- `src/runtime/progress-writer.ts` — `writeProgress()` (JSON) + `writeProgressMarkdown()` (human-readable)
- `src/runtime/transcript-writer.ts` — `writeTranscript()` generates `iteration-NN-role.md`

Changes:
- `src/artifacts/artifact-store.ts` — Added `TRANSCRIPTS` to `ARTIFACT_DIRS` and `LOCAL_ONLY_ARTIFACTS`; `init()` creates `.agent/transcripts/`
- `src/scope/scope-guard.ts` — Added `progress.json`, `progress.md`, `transcripts/**` to `SYSTEM_PROTECTED_PATHS` and `ORCHESTRATOR_OWNED_PATTERNS`
- `src/agents/auditor-adapter.ts` — Added progress/transcripts to orchestrator-managed exclusions
- `src/orchestrator/run-orchestrator.ts` — `emitProgress()` + `emitTranscript()` called before/after each agent; terminal progress writes after all 3 PASSED transitions

### Layer 3: CLI Enhancements

- `src/cli/start.ts` — Added `--watch` + `--watch-interval` flags; polls `progress.json` during execution
- `src/cli/status.ts` — Added `--watch` + `--watch-interval` flags; uses `last_event_at` for fine-grained dedup
- `src/cli/providers.ts` — New `providers list` and `providers test <id>` subcommands
- `src/cli/index.ts` — Registered `providers` subcommand

### Layer 4: Codex Plugin/Skill Packaging

New files:
- `plugin/marketplace.json` — Plugin marketplace descriptor
- `plugin/plugins/review-loop/.codex-plugin/plugin.json` — Codex plugin config
- `plugin/plugins/review-loop/skills/review-loop/SKILL.md` — Skill prompt (7 rules for Codex)
- `plugin/plugins/review-loop/skills/review-loop/scripts/run-review-loop.sh` — Bash entry script
- `plugin/plugins/review-loop/skills/review-loop/scripts/run-review-loop.ps1` — PowerShell entry script
- `package.json` — Added `plugin/` to `files` array for npm distribution

## Rework Fixes (F-601 through F-604)

### F-601 (High) — Permission guard didn't scan resolved provider commands

**Root cause**: `checkPermissionModes()` only scanned `config.agents[role].command`, but at runtime `resolveCommandForAgent()` replaces it with the provider's `command_template`. Dangerous flags in provider commands were invisible.

**Fix**: `checkPermissionModes()` now calls `resolveCommandForAgent()` before scanning. Added 2 regression tests.

### F-602 (Medium-High) — Plugin files not in npm pack

**Root cause**: `package.json.files` only included `dist/`, `prompts/`, `review-loop.yaml`.

**Fix**: Added `plugin/` to `files`. Verified: `npm pack --dry-run` now includes 5 plugin files (176 total).

### F-603 (Medium-High) — No custom Provider integration test

**Root cause**: Only unit tests for provider registry; no end-to-end test with `runOrchestrator()`.

**Fix**: Added `tests/fixtures/custom-provider-cli.mjs` (simulates non-Claude AI tool) and `tests/integration/custom-provider.test.ts` (4 per-role custom providers driving full lifecycle → PASSED + commit + progress + transcripts).

### F-604 (Medium) — Progress only written after agent completion

**Root cause**: `emitProgress()` was only called after `runAgent()` returned. During long agent runs, `--watch` had no updates. `status --watch` deduped by `phase:iteration` only.

**Fix**:
- Added `emitProgress()` calls BEFORE each agent starts ("Starting Planner/Developer/Auditor/Final Auditor")
- Added terminal progress writes after all 3 PASSED transition paths (early-exit, no-commit, normal commit)
- `status --watch` now uses `phase:iteration:last_event_at` for dedup

## Engineering Gates

```
npm run typecheck: PASS (0 errors)
npm run lint: PASS (0 errors, 0 warnings)
npm run build: PASS
npm test: 691 tests passed, 0 skipped (45 files)
npm audit --omit=dev: 0 vulnerabilities
git diff --check: no whitespace errors
npm pack --dry-run: 176 files, 177.2 kB (includes 5 plugin files)
```

## Known Risks

1. **No real model smoke**: All testing done with Fake Agent. Real model smoke (acceptEdits + bypass) should be run before production use.
2. **F-503R2 digest circular dependency**: `diff_digest` comparison was dropped from resume commit verification because final-audit.md is both in the commit and affects the diff. `run_id` + `decision` + tree check provide strong but not absolute proof.
3. **Provider health checks are best-effort**: `providers test` runs the health_check command synchronously with a 10s timeout. Network-dependent providers may need longer timeouts.
4. **Plugin packaging is static**: The SKILL.md and shell scripts are templates; actual Codex Desktop integration depends on the Codex plugin runtime, which is external to this project.

## Explicit Non-Goals (Phase 7, not implemented)

- Automatic model routing based on `capability_tier` / `cost_tier`
- Multi-worktree concurrent execution
- Automatic push
- GitHub/GitLab PR creation
- Remote repository creation
- GUI
- Prompt auto-evolution
- Destructive git cleanup
