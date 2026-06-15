# DECT 落地设计文档：Codex + Claude Code Goal Review Loop

> 文档定位：本文件是交付开发人员的详细工程设计。
> 需求、范围和验收以《需求文档.md》为准；本文件负责说明如何实现。

## 1. 设计目标

在现有 `claude-code-review-loop` 项目中增加一个可靠的本地编排层，将 Codex Planner、Claude Developer、Codex Auditor、验证命令和 Git 串成可恢复的有限状态流程。

系统必须保证：

* 模型输出只是候选结果，系统状态由编排器决定。
* 每个审计结论都有可追溯证据。
* 所有返工都发生在同一个任务和同一个 Git 基线上。
* 任何机械校验失败都不能被模型的 PASS 覆盖。
* 失败、中断和超时后仍可判断下一步，而不是从头猜测。

### 1.1 实施约束

Phase 0 已确认原 `claude-code-review-loop` 是一个极简 Codex 插件原型，主要可复用的是
“Claude 执行、Codex 审查、失败返工”的工作流概念，而不是 PowerShell 代码本身。当前系统
以 TypeScript/Node.js 本地 CLI 为核心实现。后续开发遵守：

* 保持 CLI 核心与插件入口解耦。
* 不把状态机、Git、Scope Guard、Verification Runner 等核心能力塞进 Skill 文档。
* 下文模块名是逻辑职责，应映射到当前 `src/` 目录中的 TypeScript 模块。
* 命令调用必须通过适配器，不在主流程中硬编码 Codex 或 Claude CLI 参数。

---

## 2. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│                         CLI / API                           │
│  init | start | resume | status | cancel | cleanup-preview │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                       Run Orchestrator                      │
│  状态转换 | 轮次控制 | 阶段调度 | 错误归一化 | 恢复判断       │
└───────┬──────────┬──────────┬──────────┬──────────┬─────────┘
        │          │          │          │          │
┌───────▼───┐ ┌────▼─────┐ ┌──▼────────┐ ┌────▼─────┐ ┌────▼────┐
│ Agent     │ │ Artifact │ │ Verification│ │ Git      │ │ Scope   │
│ Adapters  │ │ Store    │ │ Runner      │ │ Manager  │ │ Guard   │
└───────┬───┘ └────┬─────┘ └────┬───────┘ └────┬─────┘ └────┬────┘
        │          │            │              │            │
  Codex/Claude   .agent/     shell process     git CLI    path rules
```

### 2.1 交付表面

系统分为两层：

1. **核心执行层**：`review-loop` 本地 CLI。它是唯一实现状态机、验证、Scope Guard、Git
   证据、返工和提交的组件。
2. **用户入口层**：Codex 插件/Skill。它只负责让 Codex Desktop、Codex CLI 或 IDE
   Extension 通过自然语言调用本地 CLI，并解释 `.agent/` 产物。

插件不得绕过 CLI 直接调用 Claude 或 Codex 完成工程流程。若插件需要执行任务，必须调用
`review-loop start/status/resume/cancel`。

### 2.2 逻辑模块

| 模块 | 职责 |
|---|---|
| CLI | 接收命令、参数和用户需求，展示状态和结果 |
| Run Orchestrator | 唯一允许推进 phase 的模块 |
| State Store | 原子读写 state.json，校验 schema |
| Artifact Store | 管理文档、验证日志和历史归档 |
| Agent Adapter | 调用 Planner、Developer、Auditor 并捕获输出 |
| Process Runner | 统一处理命令、超时、退出码和子进程终止 |
| Verification Runner | 执行 GOAL 中的验证命令 |
| Git Manager | 预检、分支、基线、diff、commit、tag |
| Scope Guard | 根据 Allowed/Disallowed Changes 校验文件范围 |
| Progress Reporter | 写入 progress.json/progress.md，供 Codex Desktop 或插件轮询 |
| Transcript Store | 保存 Agent stdout/stderr 摘要和可读转写 |
| Report Parser | 解析 GOAL、handoff、audit、final audit 的固定字段 |
| Lock Manager | 防止同一工作区出现两个活动运行 |
| Event Logger | 追加 iteration-log，输出结构化运行日志 |

---

## 3. 建议目录

具体目录名适配原项目，建议逻辑结构如下：

```text
src/
├─ cli/
│  ├─ init
│  ├─ start
│  ├─ resume
│  ├─ status
│  └─ cancel
├─ orchestrator/
│  ├─ run-orchestrator
│  ├─ state-machine
│  ├─ transition-guards
│  └─ recovery
├─ agents/
│  ├─ agent-adapter
│  ├─ planner-adapter
│  ├─ developer-adapter
│  ├─ auditor-adapter
│  └─ prompt-builder
├─ artifacts/
│  ├─ artifact-store
│  ├─ report-parser
│  ├─ schemas
│  └─ templates
├─ verification/
│  ├─ verification-runner
│  └─ result-writer
├─ git/
│  ├─ git-manager
│  ├─ diff-collector
│  └─ scope-guard
└─ runtime/
   ├─ process-runner
   ├─ lock-manager
   └─ atomic-file
```

---

## 4. CLI 设计

命令名应适配原项目现有 CLI。以下以 `review-loop` 表示。

### 4.1 `review-loop init`

用途：初始化项目配置和 `.agent` 目录。

行为：

1. 检查当前目录。
2. 如不存在，创建 `review-loop.yaml` 示例配置。
3. 创建 `.agent/verification`、`.agent/history`。
4. 增量写入 `.gitignore` 的本地运行文件规则，不能覆盖已有内容。
5. 若 `.agent/state.json` 等本地运行文件已经被 Git 跟踪，则停止并提示迁移，不能静默取消跟踪。
6. `init` 产生的配置和 `.gitignore` 修改由用户检查并提交；完成该提交、恢复干净工作区后才能执行 `start`。
7. 不自动创建业务代码 commit。
8. Git 未初始化时，只有显式参数 `--init-git` 才能执行 `git init`。

### 4.2 `review-loop start`

建议参数：

```text
--request <file|string>     用户需求来源
--task-slug <slug>          可选任务短名
--max-iterations <n>        默认 3
--no-commit                 通过后不自动 commit
--tag                       通过后创建 tag
--config <path>             配置文件路径
--watch                     持续输出阶段进度，适合 Codex Desktop/CLI 展示
```

行为：

1. 运行 preflight。
2. 获取锁。
3. 创建 run_id 和 state。
4. 进入 PLANNING。
5. 自动运行直到 PASSED、FAILED、BLOCKED 或 CANCELLED。

### 4.3 `review-loop resume`

行为：

1. 读取 state.json。
2. 获取锁。
3. 执行恢复一致性检查。
4. 根据 phase 和产物决定重试当前阶段或进入下一阶段。

不得通过参数强制跳过验证或审计。

### 4.4 `review-loop status`

输出：

* run_id
* 当前 phase
* 当前 iteration / max_iterations
* base_commit
* 当前分支
* 最近错误
* 下一步预期动作

建议参数：

```text
--json                      输出机器可读状态
--watch                     每隔固定时间刷新，直到终态
--interval <seconds>        watch 间隔，默认 2 秒
```

### 4.5 `review-loop cancel`

行为：

* 请求终止当前子进程。
* phase 更新为 CANCELLED。
* 保留工作区和全部证据。
* 不执行 Git 清理。

---

## 5. 配置设计

文件：`review-loop.yaml`

示例：

```yaml
version: 1

agents:
  planner:
    command: ["codex", "exec", "{prompt_file}"]
    timeout_seconds: 1800
  developer:
    command: ["sh", "-lc", "exec claude -p --permission-mode acceptEdits < \"$1\"", "claude-developer", "{prompt_file}"]
    timeout_seconds: 3600
  auditor:
    command: ["codex", "exec", "{prompt_file}"]
    timeout_seconds: 1800

loop:
  max_iterations: 3

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
  progress_update_interval_ms: 1000
```

### 5.1 配置规则

* 数组形式执行命令，避免通过 shell 拼接参数。
* `{prompt}`、`{prompt_file}`、`{run_id}` 等占位符必须使用白名单替换。
* Developer prompt 默认通过 stdin 传给 Claude CLI，不直接把 `{prompt}` 拼成 `claude -p`
  参数，避免 prompt 以 `---`、`--` 等内容开头时被 CLI 误判为选项。
* 未知配置字段可以告警，但关键字段类型错误必须停止。
* `git.push` 在 MVP 中即使配置为 true 也应拒绝，避免误开放未实现能力。
* 密钥不得写入该配置文件或 `.agent` 文档。

### 5.2 Claude 权限模式配置

`review-loop` 不保存 Claude 凭据。用户必须先通过 Claude CLI 完成账号授权，例如
`claude auth`，并确认 `claude --version` 可用。

Developer 命令支持三种典型权限策略：

默认安全模式：

```yaml
developer:
  command: ["sh", "-lc", "exec claude -p --permission-mode acceptEdits < \"$1\"", "claude-developer", "{prompt_file}"]
  timeout_seconds: 3600
```

可信沙盒 bypass：

```yaml
developer:
  command: ["sh", "-lc", "exec claude -p --permission-mode bypassPermissions < \"$1\"", "claude-developer", "{prompt_file}"]
  timeout_seconds: 3600
```

无人值守实验模式：

```yaml
developer:
  command: ["sh", "-lc", "exec claude -p --dangerously-skip-permissions < \"$1\"", "claude-developer", "{prompt_file}"]
  timeout_seconds: 3600
```

约束：

* `acceptEdits` 是默认值。
* `bypassPermissions` 或 `--dangerously-skip-permissions` 只能由用户在配置中显式开启。
* 当检测到危险跳权参数时，CLI 必须打印风险提示。
* bypass 只减少 Claude 的交互确认，不替代 Scope Guard、Verification Runner、审计和 Git
  preflight。
* 对不可信仓库、第三方代码、生产数据或不可回滚环境，禁止使用 bypass。

### 5.3 Developer Provider 配置

当前 `command` 字段已经允许接入 Claude 以外的编程 CLI。为了长期支持 CodeBuddy、
OpenCode、GLM、Qwen、Gemini CLI 等工具，后续配置应扩展为 Provider Profile。

示例：

```yaml
agents:
  developer:
    provider: "claude"
    command: ["sh", "-lc", "exec claude -p --permission-mode acceptEdits < \"$1\"", "claude-developer", "{prompt_file}"]
    prompt_transport: "stdin"
    timeout_seconds: 3600
    health_check: ["claude", "--version"]
```

自定义 CLI 示例：

```yaml
agents:
  developer:
    provider: "custom"
    command: ["sh", "-lc", "exec codebuddy run --file \"$1\"", "codebuddy-developer", "{prompt_file}"]
    prompt_transport: "prompt_file"
    timeout_seconds: 3600
    health_check: ["codebuddy", "--version"]
```

以上 CodeBuddy 命令仅表示适配方式，具体参数以用户本机 CLI 为准。`review-loop` 的要求是：

* Provider 能在项目根目录运行。
* Provider 能非交互接收任务。
* Provider 能真实修改文件。
* Provider 能生成 handoff 或可由适配器生成 handoff。
* Provider 的 stdout/stderr 能被保存到 transcript。

Provider Adapter 必须输出统一的 AgentRunResult，不得让上层 Orchestrator 关心具体 CLI。

---

## 6. Artifact 版本化边界

### 6.1 进入最终 commit

以下文件是当前任务的最终契约和审计摘要，默认进入 Git：

```text
.agent/plan.md
.agent/GOAL.md
.agent/developer-handoff.md
.agent/audit-report.md
.agent/final-audit.md
```

### 6.2 仅本地保留

以下文件包含运行状态、过程证据或潜在敏感日志，默认加入 `.gitignore`：

```gitignore
.agent/state.json
.agent/run.lock
.agent/iteration-log.md
.agent/progress.json
.agent/progress.md
.agent/verification/
.agent/evidence/
.agent/history/
.agent/debug/
.agent/transcripts/
```

规则：

* 本地文件不得处于 tracked 状态；preflight 必须检查。
* `.agent/run.lock` 在进程正常退出时删除，异常退出时留作恢复判断。
* state 可以在 commit 后写入 PASSED，不会造成工作区变脏。
* 完整过程证据如需长期保存，应复制到独立制品存储；MVP 不提交大体积日志。
* Scope Guard 将编排器生成的本地文件从 Developer 修改集合中排除，但必须通过写入归属检查防止 Developer 冒充编排器改写。

---

## 7. 状态模型

文件：`.agent/state.json`

建议 schema：

```json
{
  "schema_version": 1,
  "run_id": "20260610-153012-a1b2c3",
  "task_slug": "add-review-loop",
  "phase": "AUDITING",
  "iteration": 1,
  "max_iterations": 3,
  "project_root": "/absolute/project/path",
  "base_commit": "0123456789abcdef",
  "branch": "agent/20260610-153012-a1b2c3-add-review-loop",
  "goal_digest": "sha256:...",
  "audited_diff_digest": null,
  "started_at": "2026-06-10T22:30:12Z",
  "updated_at": "2026-06-10T22:45:01Z",
  "last_error": null,
  "stages": {
    "planning": {"status": "completed", "attempts": 1},
    "developing": {"status": "completed", "attempts": 1},
    "verifying": {"status": "completed", "attempts": 1},
    "auditing": {"status": "running", "attempts": 1},
    "finalizing": {"status": "pending", "attempts": 0}
  }
}
```

### 7.1 写入要求

* 先写临时文件，再 `fsync`，最后原子 rename。
* 每次写入前校验 schema。
* `updated_at` 由系统生成。
* 模型命令运行期间，state 必须显示对应阶段为 running。
* state 写入失败属于 BLOCKED，不能继续执行。

### 7.2 状态枚举

```text
INITIALIZING
PLANNING
DEVELOPING
VERIFYING
AUDITING
REWORKING
FINALIZING
PASSED
FAILED
BLOCKED
CANCELLED
```

### 7.3 合法转换

```text
INITIALIZING → PLANNING | BLOCKED | CANCELLED
PLANNING     → DEVELOPING | BLOCKED | CANCELLED
DEVELOPING   → VERIFYING | BLOCKED | CANCELLED
VERIFYING    → AUDITING | REWORKING | BLOCKED | CANCELLED
AUDITING     → FINALIZING | REWORKING | BLOCKED | CANCELLED
REWORKING    → VERIFYING | BLOCKED | FAILED | CANCELLED
FINALIZING   → PASSED | BLOCKED
```

说明：

* Verification 失败时不必调用 Auditor，可直接生成一条机械失败记录并进入 REWORKING。
* 达到最大轮次后，从 VERIFYING/AUDITING 进入 FAILED。
* 任意终态不得自动重新进入活动状态；恢复 CANCELLED/FAILED 需要新 run。

---

## 8. Artifact 协议

所有模型生成的 Markdown 文件使用 YAML front matter 提供机器字段，正文提供人类可读说明。

解析要求：

* front matter 必须位于文件开头。
* 未知字段允许保留。
* 必填字段缺失、枚举非法或 YAML 无法解析时，本阶段失败。
* 不允许仅靠搜索正文中的 PASS/FAIL 判定状态。

### 8.1 plan.md

```markdown
---
schema_version: 1
run_id: "20260610-153012-a1b2c3"
author_role: "planner"
---

# Plan

## Requirement Understanding
...

## Technical Approach
...

## Work Breakdown
...

## Risks
...
```

### 8.2 GOAL.md

```markdown
---
schema_version: 1
run_id: "20260610-153012-a1b2c3"
goal_id: "goal-001"
title: "Implement review loop"
allowed_changes:
  - "src/**"
  - "tests/**"
  - "docs/review-loop.md"
  - ".agent/developer-handoff.md"
disallowed_changes:
  - ".git/**"
  - ".agent/state.json"
  - ".agent/GOAL.md"
  - ".agent/audit-report.md"
  - ".agent/final-audit.md"
verification_commands:
  - id: "unit-tests"
    command: ["npm", "test"]
    cwd: "."
    required: true
    timeout_seconds: 900
  - id: "typecheck"
    command: ["npm", "run", "typecheck"]
    cwd: "."
    required: true
    timeout_seconds: 900
---

# Goal

## Objective
...

## Success Criteria

1. ...
2. ...

## Non-Goals
...

## Constraints
...
```

规则：

* `allowed_changes` 和 `disallowed_changes` 使用相对项目根目录的 glob。
* 路径不能包含 `..` 或指向项目外。
* Disallowed 优先级高于 Allowed。
* Verification 使用 argv 数组，默认不经过 shell。
* GOAL 生成后计算摘要并写入 state；后续摘要变化立即 BLOCKED。

### 8.3 developer-handoff.md

```markdown
---
schema_version: 1
run_id: "20260610-153012-a1b2c3"
iteration: 1
author_role: "developer"
status: "COMPLETED"
---

# Developer Handoff

## Summary
...

## Files Changed

- `src/...`: ...

## Verification Performed

- `npm test`: claimed passed

## Risks
...

## Unresolved Issues

- None
```

规则：

* status 只允许 COMPLETED 或 BLOCKED。
* Developer 声称的验证结果仅供参考。
* `Files Changed` 与真实 diff 不一致时，审计证据中必须标记。

### 8.4 audit-report.md

```markdown
---
schema_version: 1
run_id: "20260610-153012-a1b2c3"
iteration: 1
author_role: "auditor"
decision: "FAIL"
audited_goal_digest: "sha256:..."
audited_diff_digest: "sha256:..."
---

# Audit Report

## Decision

FAIL

## Success Criteria Review

| Criterion | Result | Evidence |
|---|---|---|
| SC-1 | PASS | ... |
| SC-2 | FAIL | ... |

## Findings

### F-001 - High - ...

- Evidence: `src/file.ts:42`
- Impact: ...
- Required fix: ...
- Verification: ...

## Scope Review
...

## Rework Instructions

1. Fix F-001 only.
```

规则：

* decision 只允许 PASS、FAIL、BLOCKED。
* PASS 时 Findings 中不得存在未解决的 Critical/High 问题。
* FAIL 时至少有一个 finding 或明确的机械失败。
* `audited_diff_digest` 必须等于编排器交给 Auditor 的证据摘要。

### 8.5 final-audit.md

```markdown
---
schema_version: 1
run_id: "20260610-153012-a1b2c3"
author_role: "auditor"
decision: "PASS"
final_iteration: 2
goal_digest: "sha256:..."
diff_digest: "sha256:..."
---

# Final Audit

## Final Decision

PASS

## Success Criteria
...

## Verification Summary
...

## Change Summary
...

## Accepted Residual Risks
...
```

final-audit 的 decision 只允许 PASS、FAILED、BLOCKED。终态为 FAILED/BLOCKED 时也必须由 Codex Auditor 生成 final-audit 并写明原因；该情况下不得 commit。

### 8.6 iteration-log.md

示例：

```markdown
## 2026-06-10T22:30:12Z | Run 20260610-153012-a1b2c3

| Time | Iteration | Phase | Event | Result |
|---|---:|---|---|---|
| 22:30:12Z | 0 | INITIALIZING | preflight | PASS |
| 22:31:01Z | 0 | PLANNING | planner completed | PASS |
| 22:40:13Z | 1 | VERIFYING | unit-tests | FAIL (exit 1) |
```

只允许 Artifact Store 追加，不允许模型重写。

---

## 9. 模型适配器

### 9.1 统一接口

伪代码：

```text
AgentAdapter.run(input):
  validate input
  build prompt or prompt file
  execute configured command through ProcessRunner
  capture stdout, stderr, exit code, duration
  verify expected artifact exists
  parse expected artifact
  return normalized result
```

统一返回：

```text
status: success | failed | timeout | cancelled
exit_code: integer | null
stdout_path: string
stderr_path: string
artifact_path: string | null
error: normalized error | null
```

Agent Adapter 之下应允许多个 Developer Provider：

```text
DeveloperProvider.run(input):
  render prompt transport (stdin | prompt_file | argv)
  execute provider command through ProcessRunner
  capture stdout/stderr
  write transcript artifact
  verify or synthesize developer-handoff.md
  return AgentRunResult
```

内置 Provider 建议：

| provider_id | 用途 |
|---|---|
| `claude` | 默认 Claude Code CLI |
| `custom` | 用户自定义命令模板 |
| `codebuddy` | CodeBuddy CLI 适配，具体命令由用户配置 |
| `opencode` | OpenCode CLI 适配，具体命令由用户配置 |

不要在 Orchestrator 中写 `if provider === "claude"` 之类的分支。差异应封装在 Provider
Profile 或 Provider Adapter 内。

### 9.2 Planner 输入

Planner 获得：

* 用户原始需求。
* 项目目录摘要。
* 项目操作说明文件，如 AGENTS.md、CLAUDE.md。
* 包管理和测试入口。
* 当前 Git 基线。
* plan.md / GOAL.md 模板和 schema。

Planner 不得获得写业务代码的指令。

### 9.3 Developer 输入

首次开发 Prompt：

```text
使用 /goal 执行当前任务。

必须读取：
- .agent/plan.md
- .agent/GOAL.md

规则：
1. 只实现 GOAL.md 中的 Success Criteria。
2. 只修改 allowed_changes；不得修改 disallowed_changes。
3. 不得修改 GOAL、state、audit 或 final-audit。
4. 不得执行 git commit、tag、push 或破坏性 Git 命令。
5. 不得删除、跳过或弱化测试以获得通过。
6. 完成后按固定格式生成 .agent/developer-handoff.md。
7. 无法完成时将 handoff status 写为 BLOCKED 并说明原因。
```

返工 Prompt 额外包含：

```text
必须读取最新 .agent/audit-report.md。
只修复 Findings 和 Rework Instructions 指定的问题，以及完成这些修复所必需的测试。
原 GOAL 不变，不得扩大任务范围。
```

### 9.4 Auditor 输入

Auditor 获得一个只读证据集合：

* plan.md
* GOAL.md
* developer-handoff.md
* Verification manifest 和日志路径
* changed-files.json
* scope-report.json
* 完整文本 diff 或 diff 文件路径
* untracked 文件内容或安全摘要
* audit-report 模板

Auditor Prompt 必须要求：

* findings 优先，按严重度排序。
* 每个问题提供文件和行号证据。
* 逐项评价 Success Criteria。
* 测试成功也不能替代代码审查。
* 不确定且影响通过时返回 BLOCKED，不得猜测 PASS。

---

## 10. Process Runner

所有外部命令统一由 Process Runner 执行。

### 10.1 必须能力

* argv 数组执行，默认 `shell=false`。
* 设置明确 cwd。
* 继承必要环境变量，但日志中对敏感变量脱敏。
* stdout/stderr 流式写文件。
* 保存退出码和运行时长。
* 支持超时。
* 超时时先发送温和终止信号，宽限期后强制终止进程组。
* 支持用户 cancel。
* 限制日志大小；截断时写明。

### 10.2 禁止

* 不允许把未经转义的用户需求拼接为 shell 字符串。
* 不允许在日志中输出 API key、token 或完整环境变量。
* 不允许忽略非零退出码。

---

## 11. Git Manager

### 11.1 Preflight

按顺序执行并保存结果：

```bash
git rev-parse --show-toplevel
git rev-parse --verify HEAD
git branch --show-current
git status --porcelain=v1 -uall
```

要求：

* Git 根目录必须等于项目根目录或经过明确配置。
* HEAD 必须存在。
* 当前不能是 detached HEAD。
* `git status` 必须为空。
* `.agent` 中旧的终态文件可以由 init/archive 处理，但不能静默覆盖活动任务。
* 第 6.2 节的本地运行文件不得已被 Git 跟踪。

### 11.2 创建任务分支

1. 记录原始分支和 base_commit。
2. 按模板生成分支名。
3. 检查分支不存在。
4. 执行等价于：

```bash
git switch -c <branch> <base_commit>
```

若创建失败，进入 BLOCKED。

### 11.3 Diff 采集

每次验证前后和审计前采集：

```bash
git status --porcelain=v1 -uall
git diff --binary --find-renames <base_commit> -- .
git diff --numstat --find-renames <base_commit> -- .
git diff --name-status --find-renames <base_commit> -- .
```

注意：普通 `git diff` 不包含未跟踪文件。实现必须：

1. 从 status 中获取未跟踪文件。
2. 校验路径在项目根目录内且不是符号链接逃逸。
3. 文本文件加入审计证据。
4. 二进制或超大文件只记录路径、大小、类型和摘要。

生成：

```text
.agent/evidence/iteration-01/
├─ tracked.diff
├─ changed-files.json
├─ untracked-files.json
└─ diff-metadata.json
```

### 11.4 Diff 摘要

对以下规范化内容计算 SHA-256：

* base_commit
* tracked.diff 原始字节
* 按路径排序的未跟踪文件摘要
* changed-files.json

摘要写入 state，并要求 audit-report 引用同一摘要。

Auditor 完成后、commit 前重新计算。若摘要变化，审计失效，必须重新验证和审计。

### 11.5 Commit

提交前检查：

1. 最新 audit decision 为 PASS。
2. final-audit decision 为 PASS。
3. GOAL digest 未变化。
4. diff digest 与被审计版本一致。
5. 所有 required verification 通过。
6. 工作区中不存在控制文件的非法修改。

然后：

```bash
git add -A
git commit -m "<rendered message>"
```

要求：

* `git add -A` 前再次确认仅本地 Artifact 均被忽略且未被跟踪。
* commit 必须包含第 6.1 节的版本化 Artifact。
* commit 失败进入 BLOCKED，不得伪造 PASSED。
* 不执行 push。
* tag 只在 commit 成功后创建。
* tag 创建失败时保留 commit，状态标记 BLOCKED，并明确指出“代码已提交、tag 未创建”，resume 只能补 tag，不得重复 commit。

### 11.6 Git 安全

代码中不得为自动流程提供以下调用路径：

```text
reset --hard
clean -fd
push --force
checkout -- <path>
restore .
```

清理功能只允许生成预览和人工操作建议，MVP 不负责自动回退。

---

## 12. Scope Guard

### 12.1 输入

* GOAL allowed_changes
* GOAL disallowed_changes
* Git changed-files.json
* 系统保护路径

系统保护路径至少包括：

```text
.git/**
.agent/state.json
.agent/GOAL.md
.agent/audit-report.md
.agent/final-audit.md
.agent/run.lock
```

Developer 阶段允许写 `.agent/developer-handoff.md`。编排器产生的 evidence、verification、history 和日志不应被计入 Developer 越界。

### 12.2 判定顺序

对每个业务改动路径：

1. 若命中系统保护路径，DENY。
2. 若命中 disallowed_changes，DENY。
3. 若未命中任何 allowed_changes，DENY。
4. 否则 ALLOW。

生成 `.agent/evidence/iteration-NN/scope-report.json`：

```json
{
  "passed": false,
  "allowed": ["src/a.ts"],
  "denied": [
    {
      "path": "package.json",
      "reason": "outside_allowed_changes"
    }
  ]
}
```

### 12.3 测试保护

机械层可检测以下信号并交给 Auditor：

* 测试文件被删除。
* 测试数量显著下降。
* `skip`、`only`、禁用测试配置等可疑变化。
* 验证脚本被改成无操作命令。

这些信号默认要求 Auditor 明确判断；测试文件删除且 GOAL 未授权时，Scope Guard 直接失败。

---

## 13. Verification Runner

### 13.1 执行规则

* 只执行 GOAL front matter 中结构化定义的命令。
* argv 数组直接传给 Process Runner。
* cwd 必须解析到项目根目录内。
* 每条命令使用独立超时。
* required 命令全部成功才视为 verification passed。
* optional 命令失败记入报告，但不机械阻止审计。

### 13.2 Manifest

`.agent/verification/manifest.json`：

```json
{
  "schema_version": 1,
  "run_id": "20260610-153012-a1b2c3",
  "iteration": 1,
  "passed": false,
  "started_at": "2026-06-10T22:40:00Z",
  "finished_at": "2026-06-10T22:42:31Z",
  "commands": [
    {
      "id": "unit-tests",
      "argv": ["npm", "test"],
      "cwd": ".",
      "required": true,
      "status": "failed",
      "exit_code": 1,
      "timed_out": false,
      "duration_ms": 151000,
      "stdout_path": "iteration-01/unit-tests.stdout.log",
      "stderr_path": "iteration-01/unit-tests.stderr.log"
    }
  ]
}
```

### 13.3 验证失败

* 生成机械 finding，例如 `V-001`。
* 不调用 Auditor 也可以直接进入返工，以节省高价值模型成本。
* 返工 Prompt 必须包含失败命令、退出码和日志路径。
* 下一轮必须重新运行所有 required 命令，不只运行失败项。

---

## 14. 主循环算法

伪代码：

```text
start(request):
  acquireLock()
  preflight()
  createState()
  plan()
  validateGoal()
  createTaskBranch()

  for iteration in 1..maxIterations:
    setPhase(iteration == 1 ? DEVELOPING : REWORKING)
    runDeveloper(iteration)
    validateHandoff()

    setPhase(VERIFYING)
    collectDiff()
    runScopeGuard()
    runVerification()

    if scope failed or required verification failed:
      writeMechanicalAuditFailure()
      archiveIteration()
      if iteration == maxIterations:
        finalizeFailed()
        return
      continue

    setPhase(AUDITING)
    diffDigest = collectAuditEvidence()
    runAuditor(iteration, diffDigest)
    validateAuditReport()

    if audit decision == PASS:
      setPhase(FINALIZING)
      rerunPreCommitChecks()
      runFinalAudit()
      ensureDiffUnchanged()
      commitAndOptionallyTag()
      setPhase(PASSED)
      return

    if audit decision == BLOCKED:
      finalizeBlocked()
      return

    archiveIteration()

  finalizeFailed()
```

### 14.1 轮次定义

* iteration 1：首次开发。
* iteration 2..N：返工。
* 规划失败重试不增加开发 iteration，但增加 planning attempts。
* 同一轮模型命令因基础设施瞬时失败是否重试，应由 adapter 的有限重试策略决定，默认最多 1 次，且不得对认证失败重试。

---

## 15. 机械校验与模型审计的优先级

优先级从高到低：

1. Git 和状态一致性。
2. 控制文件完整性。
3. Scope Guard。
4. Required Verification。
5. Artifact schema。
6. Codex Auditor 结论。

规则：

```text
机械失败 + Auditor PASS = 最终 FAIL/BLOCKED
机械成功 + Auditor FAIL = 最终 FAIL
机械成功 + Auditor PASS = 可以进入 FINALIZING
任意层 BLOCKED = 最终 BLOCKED
```

---

## 16. 恢复设计

### 16.1 恢复前一致性检查

resume 必须确认：

* state schema 合法。
* 当前项目路径与 state 一致。
* 当前分支与 state.branch 一致。
* base_commit 仍存在。
* GOAL digest 未变化。
* 不存在另一有效 run.lock。
* 当前 diff 与最近阶段允许的状态一致。

任何无法自动判断的差异进入 BLOCKED，并给出人工处理说明。

### 16.2 分阶段恢复

| 当前 phase | 恢复动作 |
|---|---|
| INITIALIZING | 重新执行全部 preflight |
| PLANNING | 若 plan/GOAL 合法则继续，否则重新规划 |
| DEVELOPING/REWORKING | 不假设模型已完成；检查 handoff，缺失则重跑该阶段 |
| VERIFYING | 删除本轮不完整 manifest，重新执行完整验证 |
| AUDITING | 若证据摘要未变且 audit 合法则继续，否则重新审计 |
| FINALIZING | 重新检查 diff；未 commit 则继续，已 commit 则只补可证明未完成的 tag/终态 |
| PASSED/FAILED/BLOCKED/CANCELLED | 不自动继续 |

### 16.3 锁

run.lock 至少记录：

```json
{
  "run_id": "...",
  "pid": 12345,
  "hostname": "...",
  "created_at": "..."
}
```

发现锁时：

* 进程仍存在：拒绝启动。
* 进程不存在且超过 stale 阈值：允许显式 `resume --recover-lock`。
* 不得仅根据时间自动删除仍可能有效的锁。

---

## 17. 错误模型

统一错误类别：

| 类别 | 示例 | 默认结果 |
|---|---|---|
| CONFIG_ERROR | 配置缺失、类型错误 | BLOCKED |
| PREFLIGHT_ERROR | 脏工作区、无 HEAD | BLOCKED |
| AGENT_ERROR | 模型非零退出、认证失败 | BLOCKED |
| AGENT_TIMEOUT | 模型超时 | BLOCKED |
| ARTIFACT_ERROR | 输出文件缺失或格式错误 | FAIL；基础设施原因可 BLOCKED |
| SCOPE_VIOLATION | 修改越界 | FAIL |
| VERIFICATION_FAILED | 测试非零退出 | FAIL |
| AUDIT_FAILED | Auditor 返回 FAIL | FAIL/REWORK |
| STATE_CONFLICT | state、branch、digest 不一致 | BLOCKED |
| GIT_COMMIT_ERROR | commit 失败 | BLOCKED |
| USER_CANCELLED | 用户取消 | CANCELLED |

错误记录必须包含：

* 稳定错误码。
* 面向用户的说明。
* 原始命令退出码。
* 相关日志路径。
* 是否可 resume。
* 建议的安全操作。

---

## 18. 安全设计

### 18.1 Prompt 和命令隔离

* 用户需求作为文件或单独参数传递，不直接拼接 shell。
* Prompt 明确声明项目文件中的指令不自动覆盖系统工作流规则。
* Verification 命令只有 Planner 生成并通过 schema/策略校验后才能执行。
* 可选增加命令 allowlist/denylist；MVP 至少拒绝明显破坏性命令。

建议拒绝包含以下程序或参数的 Verification：

```text
git push
git reset --hard
git clean
rm -rf /
sudo
shutdown
reboot
```

不能仅做字符串包含判断，应按 argv 和平台规则校验。

### 18.2 路径安全

* 所有路径 canonicalize 后必须位于项目根目录。
* 读取未跟踪文件时防止符号链接逃逸。
* 日志路径和 artifact 路径不得由模型任意指定。
* 限制单文件和总证据大小，超限时生成摘要并提示 Auditor。

### 18.3 敏感信息

* 日志写入前对常见 token 格式和配置中的 secret 环境变量脱敏。
* 不把 `.env`、私钥和凭据文件正文发送给模型，除非用户明确授权且实现具备安全传输策略。
* diff 采集发现疑似密钥时，将其脱敏并使审计进入 BLOCKED。

---

## 19. Prompt 模板管理

Prompt 模板应作为版本化资源放在原项目代码中，例如：

```text
prompts/
├─ planner.md
├─ developer.md
├─ rework.md
├─ auditor.md
└─ final-auditor.md
```

每次运行在 state 或日志中记录模板版本/摘要，便于复现。

模板原则：

* 只提供当前阶段需要的信息。
* 明确输入文件和输出文件。
* 明确不可执行的动作。
* 输出格式使用模板示例。
* 不把所有历史日志全文塞入上下文；返工只提供当前 Goal、最新 audit 和必要证据。

---

## 20. 测试设计

### 20.1 单元测试

必须覆盖：

* state schema 和合法状态转换。
* YAML front matter 解析。
* GOAL digest 检测。
* glob Allowed/Disallowed 优先级。
* 未跟踪文件识别。
* diff digest 稳定性。
* 配置占位符替换和非法占位符。
* Process Runner 超时和取消。
* 敏感信息脱敏。
* 原子文件写入失败处理。

### 20.2 集成测试

使用临时 Git 仓库和假 Agent 可执行程序，覆盖：

1. 首轮 PASS 并 commit。
2. 首轮 FAIL、第二轮 PASS。
3. 三轮失败，不 commit。
4. required verification 失败，不调用 Auditor。
5. Developer 修改禁止文件。
6. Developer 未生成 handoff。
7. Auditor 输出非法 decision。
8. Auditor PASS 但机械校验失败。
9. 审计后 diff 被改变，强制重新审计。
10. commit 成功、tag 失败、resume 补 tag。
11. 模型超时，子进程被终止。
12. 运行中 cancel。
13. 脏工作区拒绝启动。
14. 未跟踪文件进入审计证据。
15. run.lock 防止并发运行。

### 20.3 恢复测试

分别在以下时点模拟进程崩溃：

* state 写入前后。
* Developer 完成但 handoff 尚未解析。
* 第一个验证命令完成后。
* Auditor 已写报告但 state 未推进。
* commit 前。
* commit 后、tag 前。

恢复后应确保不跳过阶段、不重复 commit、不丢失历史。

### 20.4 端到端验收

准备一个最小示例仓库：

* 包含一个可修复的小功能。
* 包含 unit test 和 lint/typecheck。
* Fake Planner/Developer/Auditor 用于 CI 稳定测试。
* 可选真实 Codex/Claude smoke test，不作为普通 CI 的硬依赖。

---

## 21. 日志与可观测性

运行日志至少包含：

* run_id、iteration、phase。
* 命令开始/结束、耗时和退出码。
* 状态转换。
* 产物解析结果。
* diff 和 Goal 摘要。
* commit/tag 结果。

日志不得默认输出完整 Prompt 和敏感环境变量。调试模式可以保存脱敏后的 Prompt 到 `.agent/debug/`。

### 21.1 桌面端进度文件

为让 Codex Desktop/插件看到工作进度，编排器必须持续写入：

```text
.agent/progress.json
.agent/progress.md
```

`progress.json` 建议结构：

```json
{
  "schema_version": 1,
  "run_id": "20260614-xxxxxx",
  "phase": "DEVELOPING",
  "iteration": 2,
  "max_iterations": 3,
  "current_role": "developer",
  "provider": "claude",
  "status": "running",
  "last_event": "Developer running",
  "last_event_at": "2026-06-14T12:00:00.000Z",
  "next_action": "wait for developer-handoff.md",
  "artifact_paths": [
    ".agent/GOAL.md",
    ".agent/developer-handoff.md"
  ]
}
```

`progress.md` 是给用户看的短摘要，Codex 插件可以直接读取并贴回对话。

### 21.2 Transcript

Agent 的完整交互不一定是结构化聊天，但至少要保存可追溯文本：

```text
.agent/transcripts/iteration-01-planner.md
.agent/transcripts/iteration-01-developer.md
.agent/transcripts/iteration-01-auditor.md
```

Transcript 来源：

* Provider stdout/stderr 脱敏摘要。
* 关键命令开始/结束时间。
* 产物路径。
* 必要时保存 JSONL 原始流，但不得提交到 Git。

Codex Desktop 中显示的是 progress 和 transcript 摘要，不保证等同于 Claude/CodeBuddy/OpenCode
自己的完整会话 UI。

CLI 最终输出示例：

```text
Run: 20260610-153012-a1b2c3
Result: PASSED
Iterations: 2/3
Branch: agent/20260610-153012-a1b2c3-add-review-loop
Commit: 8f13c2a
Tag: agent-20260610-153012-a1b2c3-pass
Final audit: .agent/final-audit.md
```

---

## 22. 实施阶段

### Phase 0：原项目调研

交付：

* 当前架构图。
* CLI 入口、配置方式和测试方式。
* 可复用模块清单。
* 与本文设计的差异说明。

### Phase 1：协议和状态基础

实现：

* Artifact schema/parser。
* State Store 和状态机。
* Atomic write。
* Lock Manager。

### Phase 2：Git 和验证基础

实现：

* Preflight。
* 分支和基线。
* Diff Collector。
* Scope Guard。
* Process/Verification Runner。

### Phase 3：Agent 编排

实现：

* Planner/Developer/Auditor Adapter。
* Prompt Builder。
* 首轮开发和审计。

### Phase 4：返工和恢复

实现：

* 多轮循环。
* history 归档。
* resume。
* 超时、取消和错误归一化。

### Phase 5：Finalization

实现：

* Final Audit。
* Pre-commit digest check。
* Commit/tag。
* 完整 CLI 状态输出。

### Phase 6：插件包装、质量与文档

实现：

* Codex 插件/Skill 包装层。
* CLI 与插件的自然语言入口联动。
* Claude permission mode 配置和风险提示。
* Developer Provider Profile，支持 Claude、CodeBuddy、OpenCode、custom CLI。
* `start --watch`、`status --watch`、progress.json/progress.md。
* transcripts 记录和插件侧摘要展示。
* 单元、集成、恢复、E2E 测试。
* 安装和配置文档。
* 故障排查文档。
* 示例仓库演示。

### Phase 7：智能任务路由与多 worktree 并发

实现：

* 项目级 Task Graph / DAG 拆解。
* 任务复杂度分类器。
* Provider Router：按复杂度、风险、成本和历史通过率选择 Developer Provider。
* Worktree Scheduler：为可并发任务创建独立 Git worktree 和任务分支。
* 并发上限、Provider 速率限制和预算控制。
* Integration Orchestrator：顺序合并已通过任务，重新运行全量验证和集成审计。
* 冲突、验证失败和集成审计失败时安全停止。

Phase 7 不改变 Phase 1-6 的原则：单个工作区仍只能有一个活动 run；并发只能发生在隔离
worktree 中，不能多个 CLI 同时写同一个目录。

---

## 23. 开发交付清单

开发人员提交实现时必须同时提供：

* 功能代码。
* 配置 schema 和示例。
* 所有 Artifact 模板和解析器。
* 状态机图或状态转换表。
* 自动化测试。
* 示例项目或测试 fixture。
* CLI 使用说明。
* `start`、`resume`、`status`、`cancel` 示例。
* 安全限制和已知问题。
* 从原项目升级的兼容性说明。

---

## 24. 开发验收检查表

### 流程

- [ ] 一条命令可从需求运行到最终结果。
- [ ] Planner、Developer、Auditor 职责分离。
- [ ] FAIL 可自动进入下一轮返工。
- [ ] 达到最大轮次后停止。

### 证据

- [ ] 审计包含完整 tracked diff。
- [ ] 未跟踪文件被纳入审计。
- [ ] Verification 记录真实退出码。
- [ ] 每轮 handoff/audit 被归档。

### 范围

- [ ] Allowed/Disallowed 可机器校验。
- [ ] Developer 无法通过修改控制文件获得 PASS。
- [ ] 审计后改动会使原 PASS 失效。

### Git

- [ ] 脏工作区拒绝启动。
- [ ] 同一任务只创建一个任务分支。
- [ ] FAIL 不 commit。
- [ ] PASS 才 commit。
- [ ] 默认不 push。
- [ ] 不执行破坏性 Git 清理。

### 恢复

- [ ] 关键阶段中断均可安全 resume。
- [ ] 不重复 commit。
- [ ] Phase 1-6 中，同一工作区并发运行被锁阻止。
- [ ] Phase 7 中，并发任务只允许在独立 Git worktree 中运行。

### 安全

- [ ] 命令不用不安全 shell 拼接。
- [ ] 超时可终止进程组。
- [ ] 日志和证据会脱敏。
- [ ] 路径不能逃逸项目根目录。

---

## 25. 关键实现决策总结

1. `.agent/state.json` 是机器状态；Markdown 是过程证据，不承担状态恢复的唯一来源。
2. GOAL 使用结构化 front matter，避免从自然语言猜 Allowed Changes 和 Verification。
3. 一个任务一个分支，返工不新建分支。
4. `base_commit` 固定，所有轮次审查累计 diff。
5. 未跟踪文件必须单独采集，不能只运行 `git diff`。
6. 机械校验优先于模型判断。
7. 审计后的 diff 变化会使 PASS 作废。
8. commit 由编排器执行，Developer 和 Auditor 都无权提交。
9. 默认要求干净工作区，不自动清理用户文件。
10. Phase 1-6 只做本地单任务闭环，不 push、不在同一工作区并行、不自动进化 Harness。
11. 后续并发必须通过 Task Graph、Provider Router、独立 Git worktree 和 Integration Audit 实现。
