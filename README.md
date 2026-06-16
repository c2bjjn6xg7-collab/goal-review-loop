# Goal Review Loop

`goal-review-loop` is a local Agent Harness for controlled AI coding work.

It lets a planner model create a scoped implementation plan, a developer model edit the
project, verification commands check the real result, and an auditor model review the
actual git diff before finalization.

The project is designed for local-first usage. It does not store model API keys in this
repository. Provider authentication stays inside the user's local CLI tools, such as
Claude Code or Codex CLI.

## What It Does

- Plans work into `.agent/GOAL.md` and `.agent/plan.md`
- Runs a configured developer CLI against a generated prompt
- Enforces allowed file scopes with Scope Guard
- Runs configured verification commands
- Supports automatic rework loops
- Records progress and transcripts for long-running tasks
- Runs final audit and optional local git commit/tag
- Supports provider profiles for `claude`, `codex`, `codebuddy`, `opencode`, and custom CLIs

## Requirements

- macOS, Linux, or another POSIX-like shell for the default examples
- Git
- Node.js `^20.19.0`, `^22.13.0`, or `>=24.0.0`
- At least one local AI coding CLI, for example:
  - Claude Code CLI
  - Codex CLI
  - another compatible provider configured in `review-loop.yaml`

Each user should log in to their own provider CLI locally. Do not commit provider
tokens, API keys, `.env` files, or local session files.

## Install From Source

```bash
git clone <your-repo-url>
cd goal-review-loop
npm ci
npm run build
npm install -g .
review-loop --help
```

Check provider availability:

```bash
review-loop providers list
review-loop providers test claude
review-loop providers test codex
```

## Use In A Target Project

Run these commands inside the project you want the agents to edit:

```bash
cd /path/to/your/project
git status
review-loop init
```

Review the generated `review-loop.yaml`, then start with a small task:

```bash
review-loop start --watch --request "Add a small hello function with tests."
```

Useful follow-up commands:

```bash
review-loop status
review-loop status --watch
review-loop resume
review-loop cancel
```

Runtime evidence is written under `.agent/` in the target project. Local runtime files
such as state, progress, evidence, transcripts, and history are ignored by the generated
`.gitignore`.

## Permission Modes

The developer provider command is configured in `review-loop.yaml`.

For Claude Code, a conservative default is:

```yaml
agents:
  developer:
    provider: claude
    command:
      - "sh"
      - "-lc"
      - "exec claude -p --permission-mode acceptEdits < \"$1\""
      - "claude-developer"
      - "{prompt_file}"
```

For isolated local test repositories, users may choose stronger automation such as
`bypassPermissions` or `--dangerously-skip-permissions`. Only do this in trusted,
version-controlled, disposable or easy-to-rollback workspaces.

Even when a provider is allowed to edit files directly, `goal-review-loop` still checks
scope, verification output, audit results, and final git state before marking a task as
passed.

## Codex Desktop Usage

This repository includes a Codex plugin wrapper under `plugin/`. The plugin is an entry
point around the local CLI. The CLI remains the source of truth.

Typical usage pattern:

```text
Codex Desktop
  -> Review Loop skill/plugin
  -> local review-loop CLI
  -> configured provider CLIs
  -> .agent evidence and final status
```

You can watch progress from the terminal with:

```bash
review-loop status --watch
```

Codex Desktop can also read the generated `.agent/` artifacts and summarize the current
state.

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm audit --omit=dev
npm pack --dry-run
```

## Before Publishing Publicly

Recommended checks before pushing to GitHub:

```bash
git status --short
rg -n --hidden --glob '!node_modules/**' --glob '!dist/**' \
  "sk-|ghp_|github_pat_|AKIA|BEGIN .*PRIVATE KEY|api[_-]?key|secret|token"
npm run typecheck
npm run lint
npm test
npm run build
```

The broad secret scan may report false positives from tests or variable names. Review
the output manually before publishing.

## License

MIT
