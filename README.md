# Goal Review Loop

中文说明见下方。English documentation follows after the Chinese section.

---

## 中文说明

`goal-review-loop` 是一个本地 Agent Harness，用来把 AI 编程工作变成更可控的工程流程。

它的核心思路是：

```text
Planner 规划任务
  -> Developer 编写代码
  -> Verification 跑真实测试和检查
  -> Auditor 审计真实 git diff
  -> Final Auditor 做最终确认
  -> 可选本地 git commit/tag
```

它不会把你的 API Key、Claude/Codex 登录信息或本地会话文件保存到仓库里。模型登录和授权都由你本机已经安装的 CLI 工具负责，例如 Claude Code CLI、Codex CLI，或其他兼容的编程 CLI。

### 它能做什么

- 生成 `.agent/GOAL.md` 和 `.agent/plan.md`
- 调用配置好的 Developer CLI 执行开发任务
- 用 Scope Guard 限制可修改文件范围
- 自动运行验证命令，例如 `npm test`、`npm run build`
- 支持审计失败后的自动返工循环
- 记录进度、证据和 transcript，方便长任务查看
- 通过 Final Auditor 后可选本地提交和打标签
- 支持 Provider Profile：`claude`、`codex`、`codebuddy`、`opencode` 和 custom provider

### 环境要求

- Git
- Node.js `^20.19.0`、`^22.13.0` 或 `>=24.0.0`
- 至少一个本地 AI 编程 CLI，例如：
  - Claude Code CLI
  - Codex CLI
  - 其他能通过命令行接收 prompt、修改项目文件并返回退出码的工具

每个使用者都应该在自己电脑上登录自己的 AI CLI。不要把 token、API Key、`.env`、私钥或本地 session 文件提交到仓库。

### 从源码安装

```bash
git clone https://github.com/c2bjjn6xg7-collab/goal-review-loop.git
cd goal-review-loop
npm ci
npm run build
npm install -g .
review-loop --help
```

检查本机 provider 是否可用：

```bash
review-loop providers list
review-loop providers test claude
review-loop providers test codex
```

如果 `codex` 或 `claude` 检测失败，先确认对应 CLI 已安装、已登录，并且命令在 `PATH` 里。

### 在自己的项目里使用

进入你想让 AI 修改的项目目录：

```bash
cd /path/to/your/project
git status
review-loop init
```

`review-loop init` 会生成 `review-loop.yaml` 和 `.agent/` 目录。请先检查 `review-loop.yaml` 里的 provider 和命令配置。

建议第一次先跑一个很小的任务：

```bash
review-loop start --watch --request "添加一个 hello 函数，并补充对应测试"
```

常用命令：

```bash
review-loop status
review-loop status --watch
review-loop resume
review-loop cancel
```

运行时证据会写入目标项目的 `.agent/` 目录。生成的 `.gitignore` 会忽略本地运行状态、进度、证据、history、transcripts 等文件。

### Claude Code 授权和 bypass 怎么理解

Developer 的执行命令在目标项目的 `review-loop.yaml` 里配置。

保守模式示例：

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

如果你在可信、隔离、可回滚的本地测试仓库里使用，也可以配置更高自动化权限，例如：

```yaml
agents:
  developer:
    provider: claude
    command:
      - "sh"
      - "-lc"
      - "exec claude -p --permission-mode bypassPermissions < \"$1\""
      - "claude-developer"
      - "{prompt_file}"
```

或者：

```yaml
agents:
  developer:
    provider: claude
    command:
      - "sh"
      - "-lc"
      - "exec claude -p --dangerously-skip-permissions < \"$1\""
      - "claude-developer"
      - "{prompt_file}"
```

请只在可信仓库里使用 bypass。不要在生产数据目录、不可信代码仓库、没有 git 保护的目录里开启高权限模式。

即使开启 bypass，`goal-review-loop` 仍然会做 Scope Guard、Verification、Auditor 和最终状态检查。

### Codex Desktop 里怎么用

本仓库包含一个 Codex plugin wrapper，路径在 `plugin/` 下。插件只是入口，真正执行的是本地 `review-loop` CLI。

典型链路：

```text
Codex Desktop
  -> Review Loop Skill / Plugin
  -> 本地 review-loop CLI
  -> 配置好的 Claude / Codex / 其他 Provider CLI
  -> .agent 证据和最终状态
```

你也可以在终端里看进度：

```bash
review-loop status --watch
```

Codex Desktop 可以读取 `.agent/` 里的状态、审计报告和 transcript 摘要，但外部 Developer CLI 自己的完整对话历史不一定会原样出现在 Codex 对话里。

### 给朋友使用

朋友只需要：

1. clone 这个仓库
2. `npm ci && npm run build && npm install -g .`
3. 自己安装并登录 Claude/Codex 或其他 provider CLI
4. 在自己的项目里执行 `review-loop init`
5. 用 `review-loop start --watch --request "..."` 启动任务

你的账号、token、key 不会随仓库一起给出去。

### 开发和验证

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm audit --omit=dev
npm pack --dry-run
```

### 开源前检查

推荐推送前检查：

```bash
git status --short
rg -n --hidden --glob '!node_modules/**' --glob '!dist/**' \
  "sk-|ghp_|github_pat_|AKIA|BEGIN .*PRIVATE KEY|api[_-]?key|secret|token"
npm run typecheck
npm run lint
npm test
npm run build
```

宽泛 secret 扫描可能会扫到测试里的假 secret、变量名 token 等误报，需要人工确认。

### 协议

MIT

---

## English Documentation

`goal-review-loop` is a local Agent Harness for controlled AI coding work.

It turns AI coding into a staged engineering workflow:

```text
Planner creates a scoped plan
  -> Developer edits the project
  -> Verification runs real commands
  -> Auditor reviews the real git diff
  -> Final Auditor confirms final evidence
  -> optional local git commit/tag
```

The project is local-first. It does not store model API keys, Claude/Codex credentials,
or local session files in this repository. Provider authentication stays inside the
user's local CLI tools, such as Claude Code CLI, Codex CLI, or another compatible coding
CLI.

### What It Does

- Writes `.agent/GOAL.md` and `.agent/plan.md`
- Runs a configured developer CLI against generated prompts
- Enforces allowed file scopes with Scope Guard
- Runs verification commands such as `npm test` and `npm run build`
- Supports automatic rework loops after failed audit or verification
- Records progress, evidence, and transcripts for long-running tasks
- Supports final audit and optional local git commit/tag
- Supports provider profiles for `claude`, `codex`, `codebuddy`, `opencode`, and custom providers

### Requirements

- Git
- Node.js `^20.19.0`, `^22.13.0`, or `>=24.0.0`
- At least one local AI coding CLI, for example:
  - Claude Code CLI
  - Codex CLI
  - another CLI that can receive prompts non-interactively, edit files, and return a stable exit code

Each user should log in to their own provider CLI locally. Do not commit tokens, API
keys, `.env` files, private keys, or local session files.

### Install From Source

```bash
git clone https://github.com/c2bjjn6xg7-collab/goal-review-loop.git
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

If `codex` or `claude` is not detected, make sure the CLI is installed, authenticated,
and available on `PATH`.

### Use In A Target Project

Run these commands inside the project you want the agents to edit:

```bash
cd /path/to/your/project
git status
review-loop init
```

`review-loop init` creates `review-loop.yaml` and `.agent/`. Review the generated
provider and command configuration before starting a real task.

Start with a small task:

```bash
review-loop start --watch --request "Add a hello function with tests."
```

Useful commands:

```bash
review-loop status
review-loop status --watch
review-loop resume
review-loop cancel
```

Runtime evidence is written under `.agent/` in the target project. Generated `.gitignore`
entries ignore local state, progress, evidence, history, and transcripts.

### Claude Code Permissions

The developer command is configured in the target project's `review-loop.yaml`.

Conservative example:

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

For trusted, isolated, easy-to-rollback local repositories, users may choose stronger
automation such as:

```yaml
agents:
  developer:
    provider: claude
    command:
      - "sh"
      - "-lc"
      - "exec claude -p --permission-mode bypassPermissions < \"$1\""
      - "claude-developer"
      - "{prompt_file}"
```

or:

```yaml
agents:
  developer:
    provider: claude
    command:
      - "sh"
      - "-lc"
      - "exec claude -p --dangerously-skip-permissions < \"$1\""
      - "claude-developer"
      - "{prompt_file}"
```

Only use bypass-style modes in trusted repositories. Do not use them in production data
directories, untrusted repositories, or folders without git protection.

Even with bypass enabled, `goal-review-loop` still runs Scope Guard, Verification,
Auditor, and final state checks.

### Codex Desktop Usage

This repository includes a Codex plugin wrapper under `plugin/`. The plugin is an entry
point around the local CLI. The CLI remains the source of truth.

Typical flow:

```text
Codex Desktop
  -> Review Loop Skill / Plugin
  -> local review-loop CLI
  -> configured Claude / Codex / other provider CLI
  -> .agent evidence and final status
```

You can also watch progress from a terminal:

```bash
review-loop status --watch
```

Codex Desktop can read `.agent/` status, audit reports, and transcript summaries, but a
third-party Developer CLI's complete conversation history may not appear verbatim inside
the Codex chat.

### Sharing With Friends

Your friend can:

1. clone this repository
2. run `npm ci && npm run build && npm install -g .`
3. install and authenticate their own Claude/Codex or other provider CLI
4. run `review-loop init` in their target project
5. start a task with `review-loop start --watch --request "..."`

Your account, tokens, and keys are not included in this repository.

### Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm audit --omit=dev
npm pack --dry-run
```

### Before Publishing Publicly

Recommended checks before pushing:

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

### License

MIT
