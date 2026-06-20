# Configuration Reference

This document describes the configuration options for the Goal Review Loop, with a focus on the per-provider network/proxy settings introduced in Phase 8F.

## Configuration File

The Review Loop reads its configuration from `review-loop.yaml` in the project root. Use the `--config` CLI flag to specify an alternate path.

## Provider Network/Proxy Configuration

Each provider can have an optional `network` block that controls how proxy environment variables are set for that provider's child process. This is useful in mixed-provider environments where different CLIs need different proxy behavior — for example, when Codex (OpenAI) needs a local proxy in mainland China, while domestic Claude Code models work directly and may fail when forced through a local proxy.

### `network` Block

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `proxy_mode` | `inherit` \| `none` \| `auto` \| `custom` | Yes | How proxy environment variables are handled for this provider. |
| `candidate_ports` | `number[]` | No | Ports to probe in `auto` mode. Defaults to `[7890, 7897, 7899, 1080, 1087, 8080]`. |
| `proxy_url` | `string` | Required for `custom` | The proxy URL to use when `proxy_mode` is `custom`. |

### Proxy Modes

#### `inherit` (default)

Preserves current behavior — the child process inherits all environment variables from the parent shell, with no proxy variable modification. This is the default when the `network` block is absent.

```yaml
providers:
  claude:
    enabled: true
    network:
      proxy_mode: inherit
```

#### `none`

Unsets all proxy-related environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and their lowercase variants) for the child process. `NO_PROXY` and `no_proxy` are preserved. Use this for providers that should connect directly without a proxy.

```yaml
providers:
  claude:
    enabled: true
    network:
      proxy_mode: none
```

#### `auto`

Probes a list of candidate ports on `127.0.0.1` via TCP connect. If an open port is found, sets `HTTP_PROXY` and `HTTPS_PROXY` (both uppercase and lowercase) to `http://127.0.0.1:<port>`. If no port is open, falls back to `none` behavior (unsets proxy vars).

```yaml
providers:
  codex:
    enabled: true
    network:
      proxy_mode: auto
      candidate_ports: [7890, 7897, 7899]
```

When `candidate_ports` is omitted, the default ports are probed: `7890`, `7897`, `7899`, `1080`, `1087`, `8080`.

#### `custom`

Sets `HTTP_PROXY` and `HTTPS_PROXY` (both uppercase and lowercase) to the configured `proxy_url`. The `proxy_url` field is required when using `custom` mode.

```yaml
providers:
  opencode:
    enabled: true
    network:
      proxy_mode: custom
      proxy_url: "http://my-proxy:3128"
```

### Cross-Platform Notes

- Both uppercase and lowercase variants of proxy environment variables are set explicitly (`HTTP_PROXY` and `http_proxy`, `HTTPS_PROXY` and `https_proxy`) for cross-platform consistency.
- On Windows, environment variable names are case-insensitive; Node.js handles this automatically.
- On Unix/macOS, environment variable names are case-sensitive, so both variants are necessary for tools that check only one case.

### Environment Isolation

Proxy environment modifications apply **only** to the provider child process at launch time. The parent process environment (`process.env`) is never mutated. Each provider command sees only its own proxy settings, even when multiple providers with different `proxy_mode` values run concurrently.

### Per-Provider Examples

#### Codex with auto proxy detection

```yaml
providers:
  codex:
    enabled: true
    provider_kind: codex
    command_template: ["codex", "exec", "{prompt_file}"]
    network:
      proxy_mode: auto
      candidate_ports: [7890, 7897]
```

#### Domestic Claude with no proxy

```yaml
providers:
  claude:
    enabled: true
    provider_kind: claude
    command_template:
      - "sh"
      - "-lc"
      - "exec claude -p --permission-mode acceptEdits < \"$1\""
      - "claude-developer"
      - "{prompt_file}"
    network:
      proxy_mode: none
```

#### Custom OpenCode with explicit proxy URL

```yaml
providers:
  opencode:
    enabled: true
    provider_kind: opencode
    command_template: ["opencode", "--prompt-file", "{prompt_file}"]
    network:
      proxy_mode: custom
      proxy_url: "http://corporate-proxy.example.com:8080"
```

## Runtime Configuration

The `runtime` block controls process-execution safeguards shared across all
agent roles.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `kill_grace_seconds` | `number` (≥1) | `10` | Grace period before force-killing a timed-out process. |
| `max_log_bytes` | `number` (≥1024) | `10485760` | Hard cap on captured stdout/stderr log size per process. |
| `lock_stale_seconds` | `number` (≥60) | `86400` | Age at which a run lock is considered stale. |
| `cancel_grace_seconds` | `number` (≥1) | `10` | Grace period for cancel to take effect before force-killing. |
| `agent_idle_timeout_seconds` | `number` (≥1) | `480` | Idle timeout in seconds for a Developer attempt. If the Developer produces no stdout, stderr, or handoff-file activity within this window, the attempt is considered stalled and aborted via the per-attempt `AbortController`. Explicit small overrides (e.g. `1` or `2`) are accepted so tests can exercise the watchdog quickly. |

```yaml
runtime:
  kill_grace_seconds: 10
  max_log_bytes: 10485760
  lock_stale_seconds: 86400
  cancel_grace_seconds: 10
  agent_idle_timeout_seconds: 480
```

## Full Configuration Example

```yaml
version: 1

agents:
  planner:
    command: ["codex", "exec", "{prompt_file}"]
    timeout_seconds: 1800
    provider: codex
  developer:
    command:
      - "sh"
      - "-lc"
      - "exec claude -p --permission-mode acceptEdits < \"$1\""
      - "claude-developer"
      - "{prompt_file}"
    timeout_seconds: 3600
    provider: claude
  auditor:
    command: ["codex", "exec", "{prompt_file}"]
    timeout_seconds: 1800
    provider: codex
  final_auditor:
    command: ["codex", "exec", "{prompt_file}"]
    timeout_seconds: 1800
    provider: codex

providers:
  claude:
    enabled: true
    provider_kind: claude
    network:
      proxy_mode: none
  codex:
    enabled: true
    provider_kind: codex
    network:
      proxy_mode: auto
      candidate_ports: [7890, 7897]

loop:
  max_iterations: 3
  archive_history: true

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
  cancel_grace_seconds: 10
  agent_idle_timeout_seconds: 480
```

---

## Phase 10: Feedback Block Protocol (`feedback_protocol`)

The `feedback_protocol` block configures the ReviewLoopRequest feedback block
protocol — an optional, supplementary channel that lets agents surface issues
(questions, risks, follow-up tasks, scope concerns, verification suggestions)
via fenced YAML blocks appended to their primary artifacts.

This protocol is **failure-safe**: parse errors never block the main loop. When
`enabled: false`, the parser is not invoked and prompts carry no hint — behavior
is byte-identical to pre-Phase-10.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Master switch. When `false`, the protocol is fully inert. |
| `self_correction` | `boolean` | `false` | When `true`, a failed block is sent back to the agent for a single-block rewrite (1 retry, no recursion). |
| `max_blocks_per_document` | `integer` (1–50) | `10` | Hard cap on accepted blocks per artifact; excess tail is ignored and warned. |
| `allowed_types_per_role` | `Record<Role, FeedbackType[]>` | see below | Per-role allowlist of permitted block types. |

### Default per-role allowlist

```yaml
feedback_protocol:
  enabled: true
  self_correction: false
  max_blocks_per_document: 10
  allowed_types_per_role:
    planner: [clarify, risk_note, followup_task]
    developer: [scope_concern, verification_suggestion, risk_note, followup_task]
    auditor: [risk_note, followup_task]
    final_auditor: [risk_note, followup_task]
```

### Block types

- `clarify` — planner-only; a question. `blocking: true` pauses the run.
- `followup_task` — deferred work accumulated across runs in `.agent/followups.md`.
- `risk_note` — a disclosed risk. Treated as a diligence signal, not a defect.
- `scope_concern` — developer-flagged scope issue; does not auto-expand scope.
- `verification_suggestion` — a command the auditor should run.

### Byproduct files

The dispatcher writes four orchestrator-owned files (whitelisted by the scope
guard so they are never treated as Developer scope violations):

- `.agent/clarifications.md` — planner clarifications, injected into the next planner prompt.
- `.agent/followups.md` — checkbox log of actionable follow-ups (`followup_task`, `verification_suggestion`).
- `.agent/feedback-notes.md` — non-blocking audit notes (`risk_note`, `scope_concern`); visible to Auditor and Final Auditor prompts. A `risk_note` is a diligence signal, not a defect.
- `.agent/parse-warnings.md` — append-only log of parse failures with line numbers and excerpts.

### risk_note anti-incentive handling

The auditor and final-auditor prompts explicitly frame a developer-disclosed
`risk_note` as a positive diligence signal. REWORK/FAIL is only issued when the
risk is independently verified — never merely because a `risk_note` exists.
