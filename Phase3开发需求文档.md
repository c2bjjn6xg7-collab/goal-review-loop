---
schema_version: 1
document_type: phase-development-requirements
phase: 3
status: READY_FOR_DEVELOPMENT
phase2_audit_iteration: 16
phase2_audit_decision: PASS
primary_acceptance_platform: macOS
created_at: "2026-06-12"
---

# Phase 3 开发需求文档：Agent 首轮编排

## 1. 文档定位

本文档是 Phase 3 的开发执行规格，供开发 AI 直接读取和实施。

需求优先级如下：

1. `需求文档.md`：产品目标、角色边界和安全规则。
2. `DECT落地设计文档.md`：总体架构和协议设计。
3. 本文档：Phase 3 的范围、接口、流程、测试和验收标准。
4. `.agent/plan.md`：阶段路线参考。

发生冲突时按上述优先级处理，不得自行扩大范围。

Phase 2 已通过 macOS 主验收，现有 Git Manager、Diff Collector、Scope Guard、
Process Runner、Verification Runner、Artifact Store、State Store 和 Lock Manager
是 Phase 3 的复用基础，不得绕过或重复实现。

## 2. 用户最关心的可用进度

### 2.1 当前状态

Phase 2 完成后，系统已经能机械执行 Git、范围检查、验证和证据采集，但还不能自动调用
Planner、Developer 和 Auditor，也不能从用户需求自动走完一轮开发审计。

因此当前版本是“可靠地基”，还不是可直接使用的完整插件。

### 2.2 Phase 3 完成后的可用程度

Phase 3 完成后，应达到 **单轮开发者预览版**：

```text
用户需求
  → Codex Planner 生成 plan/GOAL
  → Claude Developer 开发并生成 handoff
  → 编排器执行 scope + verification
  → Codex Auditor 审计真实证据
  → 输出 PASS / FAIL / BLOCKED
```

届时可以在以下条件下开始小规模真实使用：

- macOS 本地环境。
- 干净且已有 HEAD 的 Git 仓库。
- 小型、低风险、可通过自动化测试验收的任务。
- 用户全程监督，并在运行结束后人工检查结果。
- 使用任务分支，不在重要生产分支直接试验。

Phase 3 仍不具备：

- 审计 FAIL 后自动返工。
- 中断后的 `resume`。
- 最终审计、自动 commit 和 tag。
- 无人值守连续运行。

因此 Phase 3 可以“开始试用”，但不能称为完整可交付插件。

### 2.3 后续成熟度

| 完成阶段 | 可用级别 | 用户能做什么 |
|---|---|---|
| Phase 2 | 工程基础 | 单独调用 Git、范围和验证模块 |
| Phase 3 | 单轮预览版 | 一条命令完成首次规划、开发、验证和审计 |
| Phase 4 | 日常 Beta | 自动返工、历史归档、取消和中断恢复 |
| Phase 5 | MVP 可用版 | 最终审计、digest 复验、本地 commit/tag，完整闭环 |
| Phase 6 | 发布准备版 | 完整 E2E、示例项目、安装文档、故障排查和分发包装 |

**建议开始真实试用的最早节点：Phase 3 通过后。**

**建议用于日常项目的节点：Phase 4 通过后。**

**建议认定“插件基本开发完成”的节点：Phase 5 通过后。**

当前仓库交付形态是 `review-loop` 本地 CLI。Codex 插件市场安装包、图形界面或远程服务
不属于 Phase 3；不得把 CLI 预览版描述成已完成市场分发的插件。

### 2.4 第一次真实试用前检查表

以下全部满足后，可以开始第一批小任务试用：

- Phase 3 审计结论为 PASS。
- `npm pack` 后安装的 `review-loop start --help` 可执行。
- Fake Agent E2E 能稳定运行到 FINALIZING。
- 真实 Codex Planner、Claude Developer、Codex Auditor smoke test 至少成功一次。
- 测试仓库工作区干净，已有 HEAD，并已备份或可随时删除。
- 任务具有明确测试，不涉及生产数据、支付、权限或不可逆迁移。
- 用户理解 Phase 3 不会自动返工，也不会自动 commit。

如果任何一项不满足，应继续开发或只使用 Fake Agent，不进入真实项目。

## 3. Phase 3 目标

Phase 3 必须实现：

1. Agent Adapter 统一接口。
2. Planner、Developer、Auditor 三个角色适配器。
3. Prompt Builder 和命令模板安全渲染。
4. `review-loop start` 的首轮编排。
5. Planner 产物、Developer handoff、Auditor report 的严格校验。
6. 角色产物所有权和控制文件不可变校验。
7. Phase 2 scope、verification、diff evidence 的真实接线。
8. 单轮 PASS、FAIL、BLOCKED 的状态推进和可诊断输出。
9. 使用 Fake Agent 的稳定自动化测试。

Phase 3 完成后，系统必须能在一个临时示例仓库中自动完成：

```text
INITIALIZING
  → PLANNING
  → DEVELOPING
  → VERIFYING
  → AUDITING
  → FINALIZING（审计 PASS，等待 Phase 5）
```

或根据结果停止在：

```text
REWORKING（需要 Phase 4 自动返工）
BLOCKED（需要用户处理）
```

## 4. 本阶段不实现

以下能力属于后续阶段，Phase 3 禁止提前实现：

- 多轮自动返工循环。
- `resume` 恢复。
- history 归档策略的完整接线。
- 运行中 `cancel` CLI。
- Final Auditor 和 `final-audit.md` 生成。
- 自动 `git add`、`git commit` 或 tag。
- 自动 push、PR 或远程仓库操作。
- FAILED 终态的完整收尾。
- Prompt 自动进化或 Agent 自主修改流程规则。
- Codex 插件市场包装或 GUI。

允许为 Phase 4/5 保留接口，但不得出现未验收能力被默认执行的路径。

## 5. 当前代码基线

必须复用以下现有能力：

| 能力 | 当前模块 |
|---|---|
| Artifact 解析与 Schema | `src/artifacts/artifact-schemas.ts` |
| Artifact 文件管理 | `src/artifacts/artifact-store.ts` |
| 配置加载 | `src/artifacts/config.ts` |
| 状态存储和合法转换 | `src/orchestrator/state-store.ts`、`state-machine.ts` |
| 运行锁 | `src/runtime/lock-manager.ts` |
| 安全进程执行 | `src/runtime/process-runner.ts` |
| Git 预检和任务分支 | `src/git/git-manager.ts` |
| 完整 Diff 和 digest | `src/git/diff-collector.ts` |
| 范围校验 | `src/scope/scope-guard.ts` |
| 验证执行 | `src/verification/verification-runner.ts` |
| CLI 骨架 | `src/cli/index.ts` |

Phase 3 不得在 Agent Adapter 内直接使用 `child_process`，必须通过 Process Runner。
不得在 Orchestrator 内手写 Git 命令，必须使用 Git Manager。

## 6. 接线前必须解决的协议问题

### 6.1 GOAL 的 `command` 与内部 `argv` 统一

当前外部 GOAL 文档和 Artifact Schema 使用：

```yaml
verification_commands:
  - id: unit-tests
    command: ["npm", "test"]
```

而内部 `VerificationCommand` 和 Verification Runner 使用 `argv`。

Phase 3 必须明确区分：

```ts
interface GoalVerificationCommand {
  id: string;
  command: string[];
  cwd: string;
  required: boolean;
  timeout_seconds: number;
}

interface VerificationCommand {
  id: string;
  argv: string[];
  cwd: string;
  required: boolean;
  timeout_seconds: number;
}
```

要求：

1. 外部 GOAL 协议继续使用 `command`，避免破坏现有文档和 Artifact。
2. GOAL 解析成功后通过单一规范化函数转换为内部 `argv`。
3. 禁止用 TypeScript 强制类型转换掩盖字段不一致。
4. 新增真实 GOAL → parse → normalize → runVerification 集成测试。

### 6.2 角色产物所有权

从 `base_commit` 采集累计 diff 时，会同时看到 Planner 生成的 `plan.md/GOAL.md` 和
Developer 的业务改动。系统必须区分合法角色产物与越权修改。

规则：

- Planner 可写：`.agent/plan.md`、`.agent/GOAL.md`。
- Developer 可写：GOAL 允许的业务文件、测试文件和
  `.agent/developer-handoff.md`。
- Auditor 可写：`.agent/audit-report.md`。
- 编排器可写：state、lock、iteration log、verification、evidence。
- Developer 不得修改 Planner 产物。
- Auditor 不得修改 Planner、Developer 或业务产物。

实现要求：

1. Planner 完成后记录 `plan.md` 和 `GOAL.md` 的 SHA-256。
2. Developer 完成后重新计算摘要；任一变化进入 `BLOCKED`。
3. Scope Guard 只能排除“已登记且摘要未变化”的 Planner/编排器产物。
4. Auditor 调用前固定业务 diff digest。
5. Auditor 完成后除 `audit-report.md` 外的 diff 不得变化。
6. 不得仅因为路径属于 `.agent` 就全部排除。

## 7. 建议代码结构

优先遵循现有项目风格，建议新增：

```text
src/
├─ agents/
│  ├─ agent-adapter.ts
│  ├─ command-renderer.ts
│  ├─ prompt-builder.ts
│  ├─ planner-adapter.ts
│  ├─ developer-adapter.ts
│  └─ auditor-adapter.ts
├─ orchestrator/
│  └─ run-orchestrator.ts
├─ cli/
│  └─ start.ts
└─ runtime/
   └─ digest.ts

prompts/
├─ planner.md
├─ developer.md
└─ auditor.md

tests/
├─ fixtures/
│  └─ fake-agent.mjs
├─ unit/
│  ├─ command-renderer.test.ts
│  ├─ prompt-builder.test.ts
│  ├─ agent-adapter.test.ts
│  ├─ planner-adapter.test.ts
│  ├─ developer-adapter.test.ts
│  └─ auditor-adapter.test.ts
└─ integration/
   └─ run-orchestrator.test.ts
```

如果现有模块职责更适合其他文件名，可以调整，但角色边界和测试要求不得省略。

## 8. Agent Adapter 统一协议

### 8.1 输入

```ts
interface AgentRunInput {
  role: 'planner' | 'developer' | 'auditor';
  project_root: string;
  run_id: string;
  iteration: number;
  prompt: string;
  expected_artifacts: string[];
  timeout_seconds: number;
  command_template: string[];
  signal?: AbortSignal;
}
```

### 8.2 输出

```ts
interface AgentRunResult {
  status: 'success' | 'failed' | 'timeout' | 'cancelled';
  exit_code: number | null;
  stdout_path: string;
  stderr_path: string;
  artifact_paths: string[];
  prompt_digest: string;
  duration_ms: number;
  error: ReviewLoopError | null;
}
```

现有 `AgentResult` 可扩展或替换，但公共导出必须保持单一明确协议。

### 8.3 执行规则

Adapter 必须：

1. 校验项目根目录和预期 Artifact 路径。
2. 生成 prompt 或临时 prompt 文件。
3. 使用命令模板安全渲染 argv。
4. 通过 Process Runner 执行。
5. 保存独立 stdout/stderr 日志。
6. 等待日志流关闭后再返回。
7. 检查预期 Artifact 是否本轮创建或更新。
8. 调用对应 Artifact Parser。
9. 校验 `run_id`、`iteration`、`author_role`。
10. 返回规范化结果，不根据自然语言 stdout 猜测成功。

非零退出、timeout、cancel、Artifact 缺失或 Schema 非法均不能返回 success。

### 8.4 陈旧 Artifact 防护

调用 Agent 前必须记录预期 Artifact 是否存在及其摘要。调用后要求：

- Artifact 不存在：失败。
- Artifact 未变化且其 `run_id` 不是当前 run：失败。
- front matter 的角色、run_id 或 iteration 不匹配：失败。
- 多余的旧 Artifact 不得被误认为当前输出。

## 9. 命令模板与 Prompt Builder

### 9.1 允许的占位符

命令模板只允许：

```text
{prompt}
{prompt_file}
{run_id}
{iteration}
{project_root}
```

要求：

- 未知占位符在执行前报 `CONFIG_ERROR`。
- 每个模板必须包含 `{prompt}` 或 `{prompt_file}` 之一。
- 替换发生在 argv 元素内，不经过 shell。
- 用户需求不得拼接为 shell 命令。
- `command[0]` 替换后必须是非空程序名。

### 9.2 Prompt 文件

使用 `{prompt_file}` 时：

- 文件位于 `.agent/debug/` 或受控临时目录。
- 权限尽可能设为当前用户可读写。
- 默认在 Agent 结束后删除正文，只保留 SHA-256 和日志路径。
- debug 模式如需保留，只能保留脱敏版本。
- Prompt 不得包含 `.env`、私钥或未授权凭据正文。

### 9.3 Prompt 构建原则

Prompt Builder 必须：

- 只披露当前角色所需信息。
- 使用明确的输入文件和输出文件。
- 重申禁止 commit、tag、push 和破坏性 Git 命令。
- 不把所有历史日志全文塞入 Prompt。
- 记录模板版本或模板摘要。
- 对用户需求使用清晰的数据边界，避免将项目文件中的文字当作流程指令。

## 10. 三个角色适配器

### 10.1 Planner Adapter

输入至少包含：

- 用户原始需求。
- `run_id`、项目根目录、Git base commit。
- 项目文件摘要和主要技术栈。
- `AGENTS.md`、`CLAUDE.md` 等操作说明文件的路径和必要内容。
- `package.json`、测试/构建入口摘要。
- plan 和 GOAL 模板。
- Phase 3 工作流规则。

Planner 只能生成：

- `.agent/plan.md`
- `.agent/GOAL.md`

Planner 完成后必须：

1. 解析 plan 和 GOAL。
2. 校验两者 `run_id` 一致。
3. 校验 GOAL 路径不包含绝对路径或 `..`。
4. 校验 Verification command 非空、cwd 安全、id 唯一。
5. 拒绝明显破坏性 Verification argv。
6. 规范化 `command` 为内部 `argv`。
7. 计算并保存 GOAL digest。

Planner 不得修改业务代码。若 Planner 调用后出现其他工作区改动，进入 `BLOCKED`。

### 10.2 Developer Adapter

Developer Prompt 必须要求：

1. 读取 `.agent/plan.md` 和 `.agent/GOAL.md`。
2. 只实现当前 GOAL。
3. 只修改 allowed changes。
4. 不修改 Planner、状态和审计文件。
5. 不执行 commit、tag、push 或破坏性 Git 操作。
6. 不删除、跳过或弱化测试。
7. 生成 `.agent/developer-handoff.md`。
8. 无法完成时写 `status: BLOCKED`。

Developer 完成后必须：

- 校验 handoff Schema、run_id、iteration 和状态。
- handoff 为 BLOCKED 时立即将运行转入 BLOCKED，不执行审计。
- 校验 plan/GOAL 摘要未变化。
- 不采信 handoff 中声称的测试结果，真实验证由编排器执行。

Phase 3 只实现首次开发 Prompt，不实现返工 Prompt 的自动调用。

### 10.3 Auditor Adapter

Auditor 只读证据至少包含：

- `plan.md`
- `GOAL.md`
- `developer-handoff.md`
- verification manifest 和日志路径
- changed-files.json
- untracked-files.json
- scope-report.json
- tracked.diff
- diff metadata 和 digest
- 审计报告模板

Auditor Prompt 必须要求：

- 基于真实证据，不采信 Developer 自评。
- findings 按严重程度排序。
- Finding 包含证据、影响和可执行修复要求。
- 逐项检查 Success Criteria。
- 不确定且影响结论时返回 BLOCKED。
- `audited_goal_digest` 和 `audited_diff_digest` 必须使用编排器提供值。

Auditor 完成后必须：

1. 解析 audit report。
2. 校验 run_id 和 iteration。
3. 校验两个 digest 精确匹配。
4. 校验 decision 为 PASS、FAIL 或 BLOCKED。
5. 校验除 audit report 外的工作区内容未变化。
6. 机械检查失败时，即使 Auditor 写 PASS，也必须拒绝 PASS。

## 11. `review-loop start` CLI

### 11.1 参数

Phase 3 应实现：

```text
review-loop start
  --request <text>
  --request-file <path>
  --task-slug <slug>
  --max-iterations <n>
  --config <path>
  --no-commit
  --tag
```

Phase 3 规则：

- `--request` 与 `--request-file` 必须二选一。
- `--request-file` 必须位于项目根目录内或由用户明确提供可读绝对路径。
- `--no-commit` 和 `--tag` 只解析并记录，不在 Phase 3 执行 commit/tag。
- 未提供 `task-slug` 时根据需求生成安全短名，不得包含路径字符。
- `max-iterations` 可以进入 state，但 Phase 3 只执行 iteration 1。

### 11.2 退出码

建议：

| 结果 | 退出码 | state phase |
|---|---:|---|
| 审计 PASS，等待 Finalization | 0 | FINALIZING |
| 审计 FAIL 或机械失败，需要返工 | 2 | REWORKING |
| 配置、Agent、状态或人工问题 | 3 | BLOCKED |
| 用户取消 | 130 | CANCELLED |

输出必须明确显示：

- run_id
- 当前分支
- 当前 phase
- audit decision
- Artifact 路径
- 下一步动作
- “尚未 commit”的提示

## 12. 首轮 Orchestrator 流程

### 12.1 初始化

1. 解析 CLI 输入。
2. 定位并 canonicalize 项目根目录。
3. 加载配置。
4. 初始化 Artifact Store。
5. 执行 Git preflight。
6. 获取 run lock。
7. 生成 run_id 和 task_slug。
8. 使用原始分支创建初始 state。
9. transition 到 PLANNING。

所有退出路径必须释放当前进程持有的 lock，但不得删除其他进程的 lock。

### 12.2 规划

1. 调用 Planner。
2. 校验 plan/GOAL 和工作区所有权。
3. 计算 GOAL digest 并写入 state。
4. 从固定 base commit 创建任务分支。
5. 更新 state.branch。
6. transition 到 DEVELOPING。

分支创建失败进入 BLOCKED，不得自动覆盖同名分支。

### 12.3 开发

1. 记录 plan/GOAL 摘要。
2. 调用 Developer iteration 1。
3. 校验 handoff。
4. 校验 plan/GOAL 未变化。
5. handoff BLOCKED 时 transition 到 BLOCKED。
6. handoff COMPLETED 时 transition 到 VERIFYING。

### 12.4 机械检查和验证

1. 从 base commit 采集累计 diff。
2. 写入 iteration-01 evidence。
3. 使用角色所有权登记排除未变化的 Planner/编排器 Artifact。
4. 执行 Scope Guard。
5. 执行 GOAL 中全部 Verification command。
6. 写入 manifest 和 scope report。

若 scope 或 required verification 失败：

- 生成可解析的机械失败说明。
- transition 到 REWORKING。
- Phase 3 到此停止，不自动调用 Developer 第二轮。
- 输出“需要 Phase 4 或人工返工”。

### 12.5 审计

仅当机械检查全部通过时：

1. 再次采集最终审计证据。
2. 固定 diff digest。
3. transition 到 AUDITING。
4. 调用 Auditor。
5. 校验 audit report 和工作区不可变性。

结果处理：

- PASS：transition 到 FINALIZING，停止；不得 commit。
- FAIL：transition 到 REWORKING，停止；不得自动返工。
- BLOCKED：transition 到 BLOCKED，停止。

Phase 3 不得把 FINALIZING 状态改成 PASSED，因为 final audit 和 commit 属于 Phase 5。

## 13. 状态和日志要求

每个阶段必须更新：

- `state.phase`
- 对应 stage status
- attempts
- timestamp
- iteration
- last_error
- goal_digest
- audited_diff_digest

iteration 1 开始前将 `state.iteration` 更新为 1。

`iteration-log.md` 至少记录：

- preflight
- lock acquired/released
- planner start/result
- GOAL validation
- branch creation
- developer start/result
- scope result
- verification result
- auditor start/result
- final Phase 3 stop reason

日志不得包含完整 Prompt 或 secret。

## 14. 错误和重试

Phase 3 至少区分：

- `CONFIG_ERROR`
- `PREFLIGHT_ERROR`
- `AGENT_ERROR`
- `AGENT_TIMEOUT`
- `ARTIFACT_ERROR`
- `SCOPE_VIOLATION`
- `VERIFICATION_FAILED`
- `AUDIT_FAILED`
- `STATE_CONFLICT`
- `USER_CANCELLED`

要求：

- 认证失败不得自动重试。
- 命令不存在不得自动重试。
- 短暂基础设施错误最多重试 1 次，并记录 attempts。
- Agent timeout 必须终止进程树。
- Artifact 缺失或非法不得通过重试旧文件伪装成功。
- 错误输出包含安全说明、日志路径和下一步，不包含 secret。

## 15. 安全约束

1. Agent 命令必须使用 argv 和 `shell: false`。
2. 用户需求只能作为 Prompt 数据，不得成为 shell 片段。
3. Agent 不得执行 commit、tag、push。
4. Planner/Developer/Auditor 的写入权限通过事后工作区校验强制执行。
5. Developer 修改 GOAL、state、audit 或 evidence 时必须失败。
6. Auditor 修改业务代码时必须使审计失效。
7. GOAL Verification command 必须拒绝明显破坏性 argv。
8. 不读取或发送 `.env`、SSH key、云凭据正文。
9. 单个证据文件和总 Prompt 大小必须受限；超限时提供摘要并标记。
10. macOS 是当前阻断验收平台；不得删除现有 Windows 兼容实现。

## 16. 自动化测试

### 16.1 单元测试

至少覆盖：

- 占位符白名单替换。
- 未知占位符拒绝。
- Prompt 与 Prompt file 两种模式。
- Prompt digest 稳定性。
- GOAL `command` 到内部 `argv` 规范化。
- Planner/Developer/Auditor 输入构建。
- Agent 非零退出、timeout、cancel。
- 预期 Artifact 缺失、未变化、Schema 非法。
- run_id、iteration、role 不匹配。
- plan/GOAL 摘要变化检测。
- audit digest 不匹配。
- Agent 修改非授权文件检测。

### 16.2 Fake Agent

测试必须提供本地 Fake Agent，可配置：

- 写合法或非法 plan/GOAL。
- 修改业务文件。
- 写 COMPLETED/BLOCKED handoff。
- 写 PASS/FAIL/BLOCKED audit。
- 不写 Artifact。
- 延迟到 timeout。
- 非零退出。
- 审计期间篡改业务文件。

普通 CI 不依赖真实 Codex、Claude、网络或登录状态。

### 16.3 集成测试

至少覆盖：

1. 首轮完整 PASS，最终 state 为 FINALIZING，且没有 commit。
2. Planner 生成非法 GOAL，运行 BLOCKED。
3. Planner 修改业务代码，运行 BLOCKED。
4. Developer 生成 BLOCKED handoff，运行 BLOCKED。
5. Developer 修改 GOAL，运行 BLOCKED。
6. Developer 越过 allowed changes，进入 REWORKING。
7. required verification 失败，进入 REWORKING，不调用 Auditor。
8. optional verification 失败但机械检查允许审计。
9. Auditor PASS，digest 匹配，进入 FINALIZING。
10. Auditor FAIL，进入 REWORKING。
11. Auditor BLOCKED，进入 BLOCKED。
12. Auditor PASS 但 digest 错误，不得进入 FINALIZING。
13. Auditor 修改业务代码，审计失效。
14. Agent timeout 后进程被终止且 lock 被释放。
15. 命令不存在或认证失败时给出可诊断 BLOCKED。

### 16.4 CLI 打包测试

打包安装后验证：

- `review-loop start --help` 可执行。
- request 参数互斥校验正确。
- Fake Agent 配置可跑通首轮 PASS。
- CLI 输出说明尚未 commit。

## 17. 验收标准

以下全部满足才算 Phase 3 完成。

### SC-1：统一 Agent Adapter

三种角色都通过统一 Adapter 和 Process Runner 执行，返回规范化结果。

### SC-2：Prompt 安全

模板版本化、占位符白名单、argv 执行、Prompt digest 和临时文件清理均正确。

### SC-3：Planner

能从用户需求生成合法 plan/GOAL，校验路径、命令和 run_id，并保存 GOAL digest。

### SC-4：协议归一化

真实 GOAL 的 `command` 能稳定转换为 Verification Runner 使用的 `argv`。

### SC-5：Developer

能执行首次开发并生成合法 handoff；BLOCKED 和 COMPLETED 行为准确。

### SC-6：角色所有权

Developer 无法修改 plan/GOAL，Auditor 无法修改业务代码，合法角色 Artifact 不被误判。

### SC-7：机械验证接线

累计 diff、scope、verification 和 evidence 使用 Phase 2 模块真实执行。

### SC-8：Auditor

Auditor 只读取证据，audit decision、run_id、iteration 和两个 digest 均严格校验。

### SC-9：机械检查优先

Scope 或 Verification 失败时，即使 Agent 声称成功，也不能进入 FINALIZING。

### SC-10：首轮 PASS

Fake Agent 示例仓库可从用户需求运行到 FINALIZING，且不 commit、不 tag、不 push。

### SC-11：首轮 FAIL

验证失败或 Auditor FAIL 时进入 REWORKING 并停止，不自动执行第二轮。

### SC-12：BLOCKED

配置、认证、Artifact、状态或 Agent 阻塞问题进入 BLOCKED，错误可诊断。

### SC-13：状态与锁

所有阶段使用合法状态转换；进程退出时只释放自己的 lock。

### SC-14：工程质量

以下命令全部通过：

```bash
npm audit --omit=dev
npm run typecheck
npm test
npm run lint
npm run build
npm pack --dry-run
git diff --check
```

### SC-15：macOS 小规模试用

在 macOS 临时示例仓库中，使用 Fake Agent 完成稳定 E2E；使用真实 Codex/Claude
完成至少一次人工监督 smoke test。真实模型 smoke test 不作为普通 CI 硬依赖，但结果
必须记录在 handoff。

## 18. 开发范围

允许修改：

```text
src/agents/**
src/orchestrator/run-orchestrator.ts
src/cli/start.ts
src/cli/index.ts
src/runtime/digest.ts
src/artifacts/config.ts
src/artifacts/artifact-schemas.ts
src/scope/scope-guard.ts
src/types.ts
src/index.ts
prompts/**
tests/**
package.json
package-lock.json
review-loop.yaml
.gitignore
.agent/developer-handoff.md
```

如需修改其他现有 Phase 1/2 文件，必须说明它是 Phase 3 接线所必需，并补回归测试。

禁止修改：

```text
.git/**
.agent/state.json
.agent/GOAL.md
.agent/audit-report.md
.agent/final-audit.md
.agent/plan.md
需求文档.md
DECT落地设计文档.md
Phase2开发需求文档.md
Phase3开发需求文档.md
```

Developer 不得自行扩大上述范围。

## 19. 交付清单

开发完成时必须提供：

- Agent Adapter 和三个角色适配器。
- Prompt Builder、命令渲染和三个模板。
- 首轮 Run Orchestrator。
- 可执行 `review-loop start`。
- GOAL command/argv 规范化。
- 角色产物所有权保护。
- Fake Agent fixture。
- 单元、集成和打包测试。
- `.agent/developer-handoff.md`。
- 真实模型 smoke test 记录；若因认证或环境无法执行，handoff 必须写明 BLOCKED 项，
  不得伪造通过。

## 20. 完成定义

Phase 3 完成不等于整个项目完成。

Phase 3 的完成定义是：

> 用户在 macOS 的干净测试仓库中执行一条 `review-loop start` 命令，系统能够自动完成
> 首次规划、首次开发、机械验证和首次 Codex 审计，并以 FINALIZING、REWORKING 或
> BLOCKED 的明确状态停止，全程不需要人工复制 plan、handoff 或 audit 内容。

达到该标准后，可以开始小规模监督试用。

要达到“日常可用”，仍需 Phase 4 的自动返工和恢复。

要达到“完整插件 MVP”，仍需 Phase 5 的 final audit、digest 复验和本地 commit/tag。
