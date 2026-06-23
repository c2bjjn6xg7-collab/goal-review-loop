# Goal Review Loop

`review-loop` 是一个本地多 Agent 自动开发流水线：Planner 拆任务 → Developer 并行编码 →
Auditor 审计 → Final Auditor 最终复核，全程由 Scope Guard、验证命令和审计门保障质量。

支持任意 CLI agent（Claude Code、Codex、OpenCode 等）作为不同角色的 provider，
支持并行任务执行、实时可视化、中断恢复。

## 快速开始

```bash
# 初始化项目配置
review-loop init

# 启动一个开发任务（默认并行模式）
review-loop start --request "实现一个功能并补充测试" --task-slug "my-feature"

# 另开终端，浏览器看实时进度
review-loop dashboard

# 或者终端看进度
review-loop status --watch
```

## CLI 命令完整列表

| 命令 | 用途 |
|---|---|
| `review-loop init` | 初始化项目配置（生成 review-loop.yaml） |
| `review-loop start --request "..." --task-slug "..."` | 启动开发任务 |
| `review-loop start --watch` | 启动任务并在终端实时显示进度 |
| `review-loop start --parallel --max-parallel-workers 2` | 显式启用并行模式 |
| `review-loop status` | 查看当前 run 状态 |
| `review-loop status --watch` | 终端实时监控（事件流） |
| `review-loop status --watch --json` | 机器可读的事件流（JSON Lines） |
| `review-loop dashboard` | 启动浏览器 dashboard（实时输出 + 事件时间线 + cancel） |
| `review-loop dashboard --port 8800` | 指定端口 |
| `review-loop resume` | 恢复中断的 run |
| `review-loop cancel` | 取消正在运行的 run |
| `review-loop clean` | 清理中断 run 的残留文件（state.json / lock / worktrees） |
| `review-loop clean --dry-run` | 预览会清理什么 |
| `review-loop config agents` | 交互式查看/切换角色 → 模型配置 |
| `review-loop config agents --set planner=claude` | 一行切换 planner 到 claude |
| `review-loop config agents --set planner=opencode/ownplan/deepseekv4pro` | 切换到 opencode + 指定模型 |
| `review-loop providers list` | 列出已注册的 agent provider |
| `review-loop providers test <provider>` | 测试 provider 是否可用 |

## 切换 Agent 模型

每个角色（planner / developer / auditor / final_auditor）可以独立配置不同的 AI CLI 和模型。
不需要手动编辑 yaml——用 `config agents` 命令：

```bash
# 查看当前配置
review-loop config agents

# 把 planner 换成 opencode + DeepSeek
review-loop config agents --set planner=opencode/ownplan/deepseekv4pro

# 把 planner 换回 claude
review-loop config agents --set planner=claude

# 把 developer 换成 codex
review-loop config agents --set developer=codex
```

支持的 provider：`claude`（Claude Code CLI）、`codex`（OpenAI Codex CLI）、`opencode`（OpenCode CLI，需配置 provider/model）。

## 可视化

### 浏览器 Dashboard

```bash
review-loop dashboard
```

打开后能看到：
- 当前阶段（初始化 → 规划 → 开发 → 验证 → 审计 → 最终复核 → 完成）
- 哪个 agent 在跑、用了什么模型
- 实时 agent 输出（`<thinking>` 已过滤，只显示可见进度）
- 事件时间线（role started/exited、task started/completed、audit decision 等）
- 心跳信号（每 30 秒，确认 agent 还活着）
- 运行产物链接（transcript、audit-report、verification log 等）
- 历史运行切换器
- 取消按钮

SSE 实时推送，不需要刷新页面。

### 终端监控

```bash
review-loop status --watch          # 文字模式
review-loop status --watch --json   # JSON Lines（给外部 UI 用）
```

## 并行执行

review-loop 支持并行任务执行。Planner 会把需求拆成多个 task，标注哪些可以并行（`parallelizable: true`），
哪些必须串行（`depends_on`）。可并行的 task 会在独立 git worktree 里同时跑。

默认已启用（`review-loop.yaml` 里 `parallel.enabled: true, max_parallel_workers: 2`）。

```bash
# 默认并行（config 已开启）
review-loop start --request "..."

# 显式指定并行 worker 数
review-loop start --request "..." --parallel --max-parallel-workers 4
```

## 中断与恢复

```bash
# 任务跑了一半中断了（Ctrl+C / 崩溃）
# 清理残留后重新跑：
review-loop clean
review-loop start --request "..."

# 或者恢复之前的 run：
review-loop resume
```

## 配置文件

`review-loop.yaml`（项目根目录）定义了 4 个角色的 agent 命令、并行设置、验证命令、git 设置。

关键配置段：

```yaml
agents:
  planner:        # 规划师，负责拆任务
  developer:      # 开发者，负责写代码
  auditor:        # 审计员，审计每轮 diff
  final_auditor:  # 最终复核，审计合并后整体

loop:
  max_iterations: 3          # 最大迭代次数
  max_agent_retries: 3       # agent 失败后重试次数（planner 和 developer 共用）

parallel:
  enabled: true              # 并行模式开关
  max_parallel_workers: 2    # 并行 worker 数
```

## 事件流

所有 run 的生命周期事件记录在 `.agent/events.jsonl`（append-only JSONL）。

事件类型包括：run.started/resumed/completed/blocked/failed、role.started/exited/heartbeat/output、
task.started/completed/blocked、wave.started/completed、verification.started/completed/failed、
audit.decision、integration.started/completed/blocked、provider.failure、artifact.created。

历史 run 的事件归档在 `.agent/history/events-<runId>.jsonl`。

## 安全保障

即使开启 bypass 权限模式，系统仍会执行：
- **Scope Guard**：agent 只能改 `allowed_changes` 范围内的文件
- **验证命令**：typecheck / lint / test 必须通过
- **审计门**：Auditor 和 Final Auditor（codex）检查 diff 质量
- **Digest 检查**：检测文件篡改

不要在不可信仓库、生产数据目录或不可回滚环境中使用 bypass。

## 授权

各 agent CLI 需要单独认证：

```bash
claude auth          # Claude Code CLI
codex auth           # Codex CLI（通常已登录）
# opencode 需要在 ~/.config/opencode/opencode.json 配置 provider
```

## 架构文档

- `docs/superpowers/specs/` — 需求文档和设计规格
- `docs/superpowers/handoffs/` — 会话交接文档
- `docs/superpowers/specs/2026-06-22-phase-9-dogfood-lessons.md` — Phase 9 工程经验和设计守则
