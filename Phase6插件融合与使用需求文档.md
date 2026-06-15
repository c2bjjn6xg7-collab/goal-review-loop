---
schema_version: 1
document_type: phase-development-requirements
phase: 6
status: DRAFT
depends_on:
  - Phase 4 auto-rework/cancel/resume semantics PASS
  - Phase 5 final audit and local commit PASS
primary_acceptance_platform: macOS
created_at: "2026-06-14"
---

# Phase 6 插件融合与使用需求文档

## 1. 文档定位

本文档定义 `review-loop` 从“本地 CLI 引擎”包装为“Codex 可调用插件/Skill”的发布需求。

关键原则：

- CLI 是核心执行引擎。
- Codex 插件/Skill 是轻量入口。
- 插件不得重写状态机、Git、验证、Scope Guard 或审计逻辑。
- 插件只负责把用户需求转换成 `review-loop` 命令，并把 `.agent/` 结果解释给用户。

Phase 6 不应在 Phase 4 语义未通过时启动。尤其是 cancel、resume、archive idempotency
必须先可靠。

## 2. 融合目标

融合 `claude-code-review-loop` 原项目的优点：

1. 用户在 Codex 中用自然语言触发复杂开发任务。
2. 长时间等待模型执行，不把短 tool timeout 误判为失败。
3. 支持 Claude Code 作为 Developer，Codex 保持 Planner/Auditor 责任。
4. 插件安装后具备清晰默认提示和使用说明。

同时保留当前系统的工程化能力：

- `.agent/state.json` 状态机。
- `.agent/progress.json` / `.agent/progress.md` 桌面端进度。
- `.agent/GOAL.md` 任务契约。
- Verification manifest。
- Scope report。
- Git diff evidence。
- 多轮 rework。
- resume/status/cancel。
- Developer transcript。
- final audit 和本地 commit/tag。

## 3. 目标用户体验

### 3.1 终端用户

```bash
review-loop init
review-loop start --request "实现用户登录表单，并补充测试"
review-loop status
```

### 3.2 Codex Desktop / Codex CLI 用户

用户说：

```text
用 Review Loop 实现这个需求：……
```

Codex 插件执行：

```bash
review-loop start --watch --request "<用户需求>"
```

运行结束后，Codex 读取：

```text
.agent/state.json
.agent/plan.md
.agent/GOAL.md
.agent/developer-handoff.md
.agent/audit-report.md
.agent/final-audit.md
```

并向用户汇报：

- 当前 phase。
- 是否 PASS / FAILED / BLOCKED / CANCELLED。
- 修改了哪些文件。
- 执行了哪些验证命令。
- 是否已经创建本地 commit/tag。
- `.agent/progress.md` 中的最新进度摘要。
- `.agent/transcripts/` 中的 Developer/Auditor 摘要路径。
- 若失败，下一步应运行 `resume`、修改配置，还是拆小任务。

## 4. 插件目录建议

```text
marketplace.json
plugins/
  review-loop/
    .codex-plugin/
      plugin.json
    skills/
      review-loop/
        SKILL.md
        scripts/
          run-review-loop.sh
          run-review-loop.ps1
```

### 4.1 plugin.json 要求

必须说明：

- 这是本地 CLI 工作流插件。
- 需要用户已经安装并能执行 `review-loop`。
- 需要本机 Codex CLI / Claude CLI 已登录或配置好凭据。
- 插件不会自动 push，不会创建远程 PR。

### 4.2 SKILL.md 要求

Skill 应要求 Codex：

1. 对复杂开发任务优先调用 `review-loop`。
2. 不直接相信 Developer 总结。
3. 读取 `.agent/` 证据后再汇报。
4. 如果 `review-loop` 返回 BLOCKED，不要自己绕过 Scope Guard 或验证。
5. 不要自动执行 `git reset --hard`、`git clean` 或 push。

## 5. CLI 与插件职责边界

| 能力 | CLI 负责 | 插件/Skill 负责 |
|---|---|---|
| Planner/Developer/Auditor 调用 | 是 | 否 |
| 状态机与锁 | 是 | 否 |
| 验证命令执行 | 是 | 否 |
| Scope Guard | 是 | 否 |
| Git diff / commit / tag | 是 | 否 |
| 安装后的自然语言入口 | 否 | 是 |
| 向用户解释结果 | 可输出摘要 | 是 |
| 长等待提示 | 可配置 timeout | 是 |
| progress.json/progress.md | 是 | 读取并展示 |
| transcript 记录 | 是 | 摘要引用 |

## 5.1 桌面端进度展示

为适配 Codex Desktop，CLI 必须提供两种进度读取方式：

```bash
review-loop start --watch --request "..."
review-loop status --watch
review-loop status --json
```

同时持续写入：

```text
.agent/progress.json
.agent/progress.md
```

插件展示策略：

1. 启动后先显示 run_id、目标分支和 max_iterations。
2. 每次 phase 变化时在 Codex 对话里汇报。
3. 长时间无 phase 变化时，只汇报 last_event，避免刷屏。
4. 用户问“现在到哪了”时，优先读取 `progress.json`。
5. 终态时读取 final audit/audit report，给出 PASS/FAILED/BLOCKED/CANCELLED。

## 5.2 Transcript 展示

Codex Desktop 不会天然显示 Claude、CodeBuddy 或 OpenCode 的完整对话。系统必须把 Agent 输出保存为
artifact：

```text
.agent/transcripts/iteration-01-developer.md
.agent/transcripts/iteration-01-auditor.md
```

插件默认只展示摘要和路径，不把大段日志塞进 Codex 对话。用户要求“展开 Developer
过程”时，插件读取 transcript 摘要。

## 6. Claude 权限模式

Developer 默认命令必须通过 stdin 传 prompt，避免 front matter 以 `---` 开头时被 CLI
误判为选项。

推荐默认命令：

```yaml
agents:
  developer:
    command:
      - "sh"
      - "-lc"
      - "exec claude -p --permission-mode acceptEdits < \"$1\""
      - "claude-developer"
      - "{prompt_file}"
    timeout_seconds: 3600
```

可信沙盒可选 bypass：

```yaml
agents:
  developer:
    command:
      - "sh"
      - "-lc"
      - "exec claude -p --permission-mode bypassPermissions < \"$1\""
      - "claude-developer"
      - "{prompt_file}"
    timeout_seconds: 3600
```

完全无人值守实验可选：

```yaml
agents:
  developer:
    command:
      - "sh"
      - "-lc"
      - "exec claude -p --dangerously-skip-permissions < \"$1\""
      - "claude-developer"
      - "{prompt_file}"
    timeout_seconds: 3600
```

该模式只能在隔离、可信、可删除的仓库中使用。插件入口不得默认开启它。

### 6.1 账号授权

`review-loop` 不负责登录 Claude。用户首次使用前需要在终端完成：

```bash
claude auth
claude --version
```

如果团队使用 API key 或无 keychain 环境，应由用户在 shell 环境或 Claude settings 中配置，
不得写入 `review-loop.yaml`、`.agent/` 或 Git 仓库。

### 6.2 工具授权

如果不希望使用 bypass，可以用 Claude CLI 的工具白名单/黑名单收紧权限：

```yaml
agents:
  developer:
    command:
      - "sh"
      - "-lc"
      - "exec claude -p --permission-mode acceptEdits --allowedTools \"Read,Edit,Bash(npm test),Bash(npm run *)\" < \"$1\""
      - "claude-developer"
      - "{prompt_file}"
```

具体工具名称和匹配语法以本机 `claude --help` 和 Claude CLI 当前版本为准。

## 6.3 其他编程 CLI Provider

Phase 6 必须把 Claude 从硬编码概念变成默认 Provider。后续接入 CodeBuddy、OpenCode
或其他编程 CLI 时，不应修改 Orchestrator 主流程，而应新增 Provider Profile。

建议新增命令：

```bash
review-loop providers list
review-loop providers test claude
review-loop providers test codebuddy
review-loop providers test opencode
review-loop config set developer.provider opencode
```

Provider Profile 至少包含：

| 字段 | 说明 |
|---|---|
| `provider_id` | `claude`、`codebuddy`、`opencode`、`custom` |
| `command_template` | 实际命令 |
| `prompt_transport` | `stdin`、`prompt_file`、`argv` |
| `health_check` | 可用性检查命令 |
| `permission_modes` | 支持的权限模式 |
| `transcript_mode` | stdout/stderr、jsonl、none |

CodeBuddy/OpenCode/custom Provider 必须满足：

- 非交互执行。
- 能在项目根目录运行。
- 能修改文件。
- 能产生稳定退出码。
- 能生成 handoff，或由 Adapter 根据输出生成 handoff 草稿再校验。
- stdout/stderr 可记录到 transcript。

## 6.4 Phase 7 预留：智能模型路由

Phase 6 只实现 Provider Profile 和插件入口，不实现自动模型选择。但 Provider Profile 的字段应为
后续 Phase 7 预留扩展空间：

- `capability_tier`：如 `strong`、`balanced`、`cheap`。
- `cost_tier`：如 `high`、`medium`、`low`。
- `recommended_task_types`：如 `architecture`、`bugfix`、`tests`、`docs`。
- `max_parallel_runs`：Provider 允许的并发上限。
- `sensitive_task_allowed`：是否允许处理安全、密钥、支付、数据迁移等敏感任务。
- `worker_roles`：可承担 `premium_worker`、`balanced_worker`、`cheap_worker` 中哪些角色。
- `escalation_target`：该 Provider 失败后建议升级到哪个 worker 或 Provider。

Phase 6 不根据这些字段自动调度，只允许展示、配置和测试 Provider。自动路由属于 Phase 7。

## 6.5 Phase 7 预留：多 worktree 并发

Phase 6 不允许多个 CLI 同时写同一个项目目录。后续如果要并发处理多个任务，必须满足：

- Planner 先生成任务 DAG。
- Scheduler 只选择无依赖、无路径冲突、验证可独立运行的任务并发。
- 每个并发任务使用独立 Git worktree、独立分支、独立 `.agent/` 目录。
- 每个任务仍走完整 Review Loop。
- 所有任务通过后，Integration 阶段顺序合并并重新运行全量验证和审计。

因此，Phase 6 插件可以展示“该能力规划中”，但不得提供实际并发启动按钮。

## 7. 安全规则

- 插件不得把 bypass 作为默认值。
- `review-loop init` 可以提供交互选项让用户选择 permission mode。
- 配置中出现 `--dangerously-skip-permissions` 时，`review-loop start` 应输出显式警告。
- 若工作区不干净，仍必须停止，不得因为 bypass 而继续。
- Developer 无论是否 bypass，都不得修改 `.agent/GOAL.md`、`.agent/state.json`、
  `.agent/audit-report.md`、`.agent/final-audit.md`。
- Auditor 不得修改业务代码。
- 真实模型 smoke 必须至少覆盖一次 bypass 或 acceptEdits 的非交互运行。

## 8. 验收标准

Phase 6 通过条件：

1. `review-loop` CLI 可独立安装和使用。
2. 插件安装后，Codex 能通过自然语言触发 `review-loop start`。
3. 插件能正确等待长任务，不把短等待误报为失败。
4. 插件能读取 `.agent/state.json` 和 audit/final audit，给用户清晰结论。
5. acceptEdits 模式 smoke PASS。
6. bypass 模式在隔离仓库 smoke PASS，并记录风险提示。
7. 插件不自动 push、不自动清理工作区、不绕过失败验证。
8. README 和故障排查文档包含 CLI、插件、权限、登录和恢复说明。
9. Codex Desktop 可通过 progress 文件看到实时进度。
10. Transcript 文件可追溯 Developer/Auditor 的关键输出。
11. 至少一个非 Claude 的 `custom` Provider Fake CLI 通过集成测试。
12. `codebuddy`、`opencode` 等具名 Provider 可以缺省为 disabled，但必须能通过配置文件接入。
