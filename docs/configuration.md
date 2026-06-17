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
```
