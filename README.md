# Goal Review Loop

`review-loop` 是一个本地 Agent Harness：让 Codex 负责规划和审计，让 Claude Code 或其他
Developer 模型负责受控编码，再由系统用真实 diff、范围校验和验证命令决定是否通过。

## 当前形态

当前核心交付物是本地 CLI：

```bash
review-loop init
review-loop start --request "实现一个小功能并补充测试"
review-loop status
review-loop resume
review-loop cancel
```

后续可以加 Codex 插件/Skill 外壳。插件只负责自然语言入口，真正执行仍然调用本地
`review-loop` CLI。

## 推荐使用流程

1. 在目标项目中确认 Git 工作区干净。
2. 初始化：

```bash
review-loop init
```

3. 检查并提交 `review-loop.yaml` 和 `.gitignore` 的初始化改动。
4. 启动任务：

```bash
review-loop start --request "你的需求"
```

5. 查看状态：

```bash
review-loop status
review-loop status --json
```

桌面端或长任务推荐：

```bash
review-loop start --watch --request "你的需求"
review-loop status --watch
```

进度文件：

```text
.agent/progress.json
.agent/progress.md
.agent/transcripts/
```

## Claude Code 授权

`review-loop` 不保存 Claude 凭据。首次使用前，用户需要在终端完成 Claude CLI 登录：

```bash
claude auth
claude --version
```

Developer 命令在 `review-loop.yaml` 中配置。默认建议使用保守权限：

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

在可信、隔离、可回滚的本地仓库中，可以显式改为 bypass：

```yaml
agents:
  developer:
    command:
      - "sh"
      - "-lc"
      - "exec claude -p --permission-mode bypassPermissions < \"$1\""
      - "claude-developer"
      - "{prompt_file}"
```

更强的无人值守模式也可用，但风险更高：

```yaml
agents:
  developer:
    command:
      - "sh"
      - "-lc"
      - "exec claude -p --dangerously-skip-permissions < \"$1\""
      - "claude-developer"
      - "{prompt_file}"
```

不要在不可信仓库、生产数据目录或不可回滚环境中使用 bypass。即使开启 bypass，本系统仍会执行
Scope Guard、Verification Runner、审计和 Git preflight。

## 其他编程 CLI

`review-loop` 的长期目标不是只支持 Claude Code。只要某个编程 CLI 能非交互接收任务、在
项目目录中改文件、返回稳定退出码，并能生成 handoff，就可以作为 Developer Provider。

当前可通过 `review-loop.yaml` 自定义 Developer 命令。后续会增加：

```bash
review-loop providers list
review-loop providers test <provider>
review-loop config set developer.provider <provider>
```

例如 CodeBuddy、OpenCode 这类工具应作为 `codebuddy`、`opencode` 或 `custom` Provider
接入，具体命令以用户本机 CLI 支持的参数为准。

## Codex 插件路线

插件阶段的目标不是重写 CLI，而是提供入口：

```text
Codex Desktop / Codex CLI / IDE Extension
  → Review Loop Skill
  → review-loop CLI
  → .agent/ 证据与最终结论
```

插件完成后，用户可以在 Codex 中说：

```text
用 Review Loop 实现这个需求：……
```

Codex 会调用本地 CLI，并根据 `.agent/state.json`、`audit-report.md` 和 `final-audit.md`
向用户汇报结果。

Codex Desktop 里能看到的是 `review-loop` 输出的进度、handoff、audit 和 transcript
摘要，不等同于外部 Developer CLI 自己的完整聊天窗口。
