# Phase 8F-R1: Provider Launch Hardening Requirements

## Stock Audit

Audit date: 2026-06-17

Current main repository:

- Path: `/Users/dengyidong/Desktop/cc劳工系统`
- Branch: `main`
- Current HEAD: `36e2ae4 feat(agent): land phase 8f provider network proxy`
- Worktree status at audit start: clean except untracked `review-loop-test-report.md`
- Phase 8F result: landed in `main`

External state to preserve:

- Phase 8F temporary worktree `/tmp/goal-review-loop-phase8g-finalization-202606161700` still contains only local runtime artifacts under `.agent/debug/`, `.agent/evidence/`, `.agent/state.json`, `.agent/transcripts/`, and `.agent/verification/`.
- Public repository `/Users/dengyidong/Desktop/goal-review-loop-public` is still dirty with Phase 8B task graph work and must not be treated as a clean baseline for this phase.
- `review-loop-test-report.md` is a user-owned untracked report in the main repository and must not be deleted or silently committed without explicit intent.

Verified completed baseline:

- Phase 8F added per-provider `network.proxy_mode` support for `inherit`, `none`, `auto`, and `custom`.
- Provider network settings are threaded through config loading, provider resolution, agent launch, and process spawning.
- Child process proxy environment is isolated from parent `process.env`.
- `docs/configuration.md` documents the Phase 8F network block.
- Required gates passed after landing Phase 8F on `main`: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `npm audit --omit=dev`, `npm pack --dry-run`, and `git diff --check`.

Important findings from dogfood and local audit:

- Claude Code should not receive Review Loop prompts through stdin redirection in the domestic Claude API setup. Stdin transport plus YAML front matter starting with `---` can lead to malformed input or option parsing surprises.
- Claude Code should receive prompt text through argv with an explicit `--` separator before the prompt payload.
- Claude Developer should run through a non-login shell or direct argv launch. `sh -lc` or user shell startup files can reintroduce proxy variables that Review Loop intentionally stripped.
- Domestic Claude should run without proxy variables. Codex may need inherited/custom proxy settings depending on whether the user is using a domestic gateway or official Codex.
- `providers test <provider>` currently performs only health checks. It does not prove that real prompt transport, `---` front matter, proxy stripping, or shell mode behavior works.
- `docs/configuration.md` includes `provider_kind` examples, but the current `ProviderConfig` schema in `src/artifacts/config.ts` does not accept `provider_kind`. Documentation examples and loadable config schema must be brought back into agreement.
- Phase 8B task graph and multi-worker work is intentionally not a clean baseline yet. Do not start multi-worker implementation in this phase.

## Objective

Harden provider launch configuration so a user can reliably run domestic Claude Code and Codex in the same Review Loop setup without hand-writing fragile shell snippets.

The phase should convert the Phase 8F dogfood lessons into explicit provider launch behavior, profile defaults, tests, and documentation. It must make `providers test` strong enough to catch prompt transport and proxy mistakes before a full Review Loop run.

## Scope

Implement a small hardening phase only. The intended surface area is:

- Provider launch profile fields and/or built-in profile defaults.
- Prompt transport handling for provider commands.
- Proxy stripping behavior at provider child-process launch.
- Provider smoke tests that execute a real prompt, not only a version command.
- Configuration documentation and sample configuration validity.
- Focused unit and integration tests.

Do not implement multi-worker scheduling, task graph execution, worktree fan-out, model routing, escalation policy, dashboard changes, or merge orchestration in this phase.

## Requirements

1. Provider launch profiles must make prompt transport explicit.
   - Supported transport modes must include `argv`, `stdin`, and `prompt_file`.
   - Claude's default or recommended domestic profile must use `argv`.
   - A provider using `argv` transport must pass prompt payload after a `--` separator when the underlying CLI accepts one.
   - A prompt beginning with YAML front matter (`---`) must be delivered as prompt text, not interpreted as a CLI option.

2. Provider launch profiles must make shell behavior explicit.
   - Supported shell modes should distinguish direct argv launch, non-login shell launch, and login shell launch.
   - Claude's default or recommended domestic profile must avoid login-shell startup files.
   - The implementation must prevent user shell startup files from silently reintroducing proxy variables after Review Loop strips them.

3. Proxy stripping must be first-class and consistent with Phase 8F.
   - Domestic Claude must be expressible as no-proxy launch behavior using the existing `network.proxy_mode: none` semantics or a clearly documented profile shortcut that maps to it.
   - Codex must remain expressible as `inherit`, `auto`, or `custom` proxy behavior.
   - Proxy deletion must apply only to the provider child process.
   - Parent `process.env` must never be mutated.

4. `providers test <provider>` must gain a real prompt smoke mode.
   - The smoke prompt must include YAML front matter beginning with `---`.
   - The test must verify that the provider can receive the prompt using its configured transport.
   - The test must run with the provider's configured network/proxy environment, not only the ambient shell environment.
   - The test must report enough detail to diagnose transport, shell, and proxy launch failures without printing secrets.
   - Health-check-only behavior may remain available, but it must be clear that health check success is weaker than prompt smoke success.

5. Claude profile hardening must cover the dogfood-safe launch shape.
   - The configured command must be able to express this behavior without requiring the user to hand-write a complex YAML shell snippet:

```yaml
P=$(cat "$1"); exec env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy claude -p --permission-mode bypassPermissions --max-turns 160 -- "$P"
```

   - The final implementation does not have to use this exact shell string if it provides equivalent behavior through safer structured fields.
   - The behavior must include non-login launch, proxy stripping, `--` before prompt text, and prompt-as-argv delivery.

6. Configuration examples must be executable and schema-valid.
   - Every YAML example in `docs/configuration.md` that is presented as a valid Review Loop config must pass `loadConfig`.
   - Either remove unsupported fields such as `provider_kind` from examples, or intentionally add schema/type support for them in the same phase.
   - Sample configs must not contain API keys, tokens, private gateway URLs, or user-local secrets.

7. Existing Phase 8F network behavior must not regress.
   - `inherit` must preserve current behavior.
   - `none` must remove `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `http_proxy`, `https_proxy`, and `all_proxy`, while preserving `NO_PROXY` and `no_proxy`.
   - `auto` must continue probing local candidate ports and fall back safely when none are open.
   - `custom` must continue setting configured proxy URL values for the provider child process.

8. Documentation must state the recommended coexistence setup.
   - Domestic Claude API: no proxy, non-login launch, argv prompt transport, `--` separator.
   - Domestic Codex gateway: use the gateway's required environment and avoid forcing official OpenAI proxy assumptions.
   - Official Codex: use inherited or custom proxy such as `127.0.0.1:7897` when needed.
   - Proxy and no-proxy providers must be able to coexist in one `review-loop.yaml`.

## Acceptance Criteria

1. `providers test claude` or an explicit prompt-smoke variant can send a prompt beginning with `---` through the configured Claude launch path and receive a successful response in an environment where proxy variables are present in the parent shell.
2. A test proves Claude no-proxy launch removes proxy variables from the child process while preserving parent `process.env`.
3. A test proves Codex can still use `inherit`, `auto`, or `custom` proxy settings independently from Claude.
4. A test proves prompt text beginning with `---` is not interpreted as a command-line option.
5. A test proves documentation examples that claim to be valid configs can be loaded by `loadConfig`.
6. Existing Phase 8F tests for `network-env`, provider registry threading, config validation, process-runner `delete_env`, and provider network integration still pass.
7. Required gates pass:
   - `npm run typecheck`
   - `npm run lint`
   - `npm test`
   - `npm run build`
   - `npm audit --omit=dev`
   - `npm pack --dry-run`
   - `git diff --check`
8. A small Review Loop smoke run can be executed with the hardened profiles, or a documented reason is recorded when local provider availability prevents the real-model smoke.

## Non-Goals

- Do not implement Phase 8B task graph generation.
- Do not implement multi-worker parallel execution.
- Do not implement worktree or branch fan-out.
- Do not implement model routing, difficulty/risk scoring, or failure escalation.
- Do not implement a proxy client, VPN, or network tunneling.
- Do not store user API keys, gateway tokens, or proxy credentials in docs, tests, or sample configs.
- Do not push to a remote repository.

## Suggested Work Breakdown

1. Audit provider launch call sites and decide whether to represent hardening as structured provider fields, built-in provider profiles, or CLI profile presets.
2. Implement prompt transport launch behavior for `argv`, `stdin`, and `prompt_file`, with Claude using argv plus `--` in the recommended profile.
3. Add shell-mode handling or remove the need for shell startup files in Claude launch.
4. Extend `providers test` with prompt smoke execution and safe diagnostics.
5. Fix `docs/configuration.md` examples so they match the actual schema, or add intentional schema/type support for any documented metadata fields.
6. Add focused unit and integration tests for front matter prompt transport, proxy stripping, and config example validity.
7. Run all gates and record any real-model smoke limitations.

## Handoff Notes

- Treat this document as the source of truth for Phase 8F-R1 planning.
- Keep `review-loop-test-report.md` out of commits unless the user explicitly decides to version it.
- Keep temporary `.agent/debug/`, `.agent/evidence/`, `.agent/transcripts/`, `.agent/verification/`, and `.agent/state.json` local-only.
- Do not use the dirty public repository as the implementation baseline.
