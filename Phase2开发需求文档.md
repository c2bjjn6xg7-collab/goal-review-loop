---
schema_version: 1
document_type: phase-development-requirements
phase: 2
status: READY_FOR_DEVELOPMENT
phase1_completion_commit: "bddd92a13d67c220acc894acd24f3a15bc8b55a3"
created_at: "2026-06-11"
---

# Phase 2 开发需求文档：Git 与验证基础

## 1. 文档定位

本文档是 Phase 2 的开发执行规格，供开发 AI 直接读取和实施。

需求优先级如下：

1. `需求文档.md`：产品需求和安全边界。
2. `DECT落地设计文档.md`：总体架构和协议设计。
3. 本文档：Phase 2 的范围、接口、验收标准和交付要求。
4. `.agent/plan.md`：阶段路线参考。

发生冲突时，按上述优先级处理，不得自行扩大范围。

Phase 1 已在提交 `bddd92a13d67c220acc894acd24f3a15bc8b55a3`
完成并通过验收。该提交是 Phase 1 完成基线；Phase 2 开发应从包含本文档的最新
仓库 HEAD 创建任务分支，不得回退或弱化 Phase 1 已有的 Artifact、状态机、原子写入
和锁协议。

## 2. 当前状态与下一步

当前系统已具备：

- TypeScript/ESM 项目基础和严格类型检查。
- Artifact front matter、运行时 Schema 和文件存储。
- `state.json`、状态转换守卫和原子写入。
- `run.lock` 获取、所有权校验和损坏锁保护。
- 基础 CLI 初始化能力。
- 190 个自动化测试。

当前还不能安全地驱动开发闭环，因为缺少：

- Git 仓库、HEAD、分支和工作区预检。
- 固定 `base_commit` 后的完整累计 diff 证据。
- 未跟踪文件和二进制文件证据。
- Allowed/Disallowed Changes 机械校验。
- 统一的外部命令执行、超时和日志管理。
- 基于 GOAL 的真实验证执行与 manifest。

因此下一步明确为：

> 实现 Git Manager、Diff Collector、Scope Guard、Process Runner 和
> Verification Runner，使系统具备进入 Agent 编排阶段前所需的机械执行与
> 证据基础。

## 3. Phase 2 目标

Phase 2 完成后，调用方应能：

1. 对目标项目执行 Git preflight，并得到结构化结果。
2. 固定任务开始时的 `base_commit`，创建单一任务分支。
3. 从 `base_commit` 到当前工作区采集完整累计改动。
4. 将 tracked、untracked、rename、delete、binary 等改动纳入证据。
5. 计算稳定、可复验的 SHA-256 diff digest。
6. 根据 GOAL 的范围规则生成机器可读的 scope report。
7. 通过统一 Process Runner 安全执行 argv 命令。
8. 真实执行 GOAL 中全部验证命令并生成 manifest 和日志。
9. 在机械检查失败时返回明确失败，不依赖 Agent 自我声明。

Phase 2 只提供可独立调用的模块及测试，不要求接通完整主循环。

### 3.1 当前验收平台

当前实际部署和主要使用环境为 **macOS**。Phase 2 的阻断性验收以 macOS 上的功能、
安全边界、工程门禁和自动化测试为准。

- macOS/POSIX 的进程执行、timeout、cancel、日志和验证行为必须全部通过。
- Windows 兼容实现继续保留，不得主动删除或弱化。
- Windows `taskkill` 路径已通过独立模拟探针验证，但原生 Windows CI 和完整自动化
  回归覆盖属于非阻断兼容性事项，不影响当前 macOS 交付进入下一阶段。
- 在项目正式声明 Windows 为受支持生产平台前，必须补齐 Windows 原生或等价的
  `taskkill` 自动化测试。

## 4. 不在本阶段范围

本阶段禁止提前实现：

- Planner、Developer、Auditor Agent Adapter。
- Prompt Builder 和模型调用编排。
- 多轮返工、history 归档和 resume。
- Final Audit 生成。
- 自动 `git add`、`git commit` 或 tag。
- 任何形式的 `git push`。
- 完整 `review-loop run` 主循环或交互界面。
- 自动清理、回滚或恢复用户工作区。

这些能力分别属于 Phase 3、Phase 4 和 Phase 5。

## 5. 全局安全约束

以下约束高于具体实现便利性：

1. 外部命令必须使用 argv 数组并默认 `shell: false`。
2. 用户输入不得拼接为 shell 命令字符串。
3. `base_commit` 在一次任务中固定，后续采集始终比较该基线。
4. 普通 `git diff` 不包含 untracked 文件，必须单独采集。
5. 不得读取项目根目录外的文件或跟随符号链接逃逸。
6. required verification 非零退出、超时或取消时不得标记通过。
7. Disallowed Changes 优先级高于 Allowed Changes。
8. 系统保护路径优先级高于所有 GOAL 路径规则。
9. 不得提供以下自动执行路径：

```text
git reset --hard
git clean -fd
git restore .
git checkout -- <path>
git push
git push --force
```

10. 日志不得输出 token、API key、密码或完整环境变量。
11. 不得覆盖用户已有分支，不得在 detached HEAD 上继续。
12. 不得以删除、跳过或弱化测试的方式制造通过结果。

## 6. 建议代码结构

开发 AI 应优先遵循现有目录和导出风格。推荐新增：

```text
src/
├─ git/
│  ├─ git-manager.ts
│  ├─ diff-collector.ts
│  └─ git-parsers.ts
├─ runtime/
│  └─ process-runner.ts
├─ scope/
│  └─ scope-guard.ts
└─ verification/
   └─ verification-runner.ts

tests/
├─ unit/
│  ├─ process-runner.test.ts
│  ├─ git-parsers.test.ts
│  ├─ scope-guard.test.ts
│  └─ verification-runner.test.ts
└─ integration/
   ├─ git-manager.test.ts
   └─ diff-collector.test.ts
```

可以根据现有代码风格合并小文件，但不得形成一个承担全部职责的巨型模块。

## 7. 功能需求

### 7.1 Process Runner

#### 7.1.1 输入

至少支持：

- 非空 argv 数组。
- 明确的 `cwd`。
- 超时时间。
- stdout/stderr 日志文件路径。
- 环境变量覆盖，但不能默认把完整环境写入日志。
- 可选取消信号。
- `kill_grace_seconds` 和 `max_log_bytes` 配置。

#### 7.1.2 执行规则

- 使用 `child_process.spawn()` 或等价 API。
- 默认 `shell: false`。
- stdout 和 stderr 必须流式写入各自文件。
- 必须持续消费子进程输出，避免日志截断后发生管道阻塞。
- 分别记录退出码、信号、开始时间、结束时间和运行时长。
- 非零退出码返回 `failed`，不得吞掉。
- 超时先温和终止；宽限期后终止整个进程组。
- 用户取消返回 `cancelled`，与 `timeout` 区分。
- 超过日志上限时停止落盘多余内容，并在日志结尾写入明确截断标记。
- 日志目录必须按需创建。

#### 7.1.3 路径与脱敏

- `cwd` 经过解析后必须位于项目根目录内。
- 日志中应对名称包含 `TOKEN`、`API_KEY`、`SECRET`、`PASSWORD`、
  `AUTHORIZATION` 的敏感值进行脱敏。
- 错误对象和调试信息也不得泄漏上述值。

#### 7.1.4 返回结果

返回结构至少包括：

```text
status: success | failed | timeout | cancelled
exit_code: number | null
signal: string | null
timed_out: boolean
cancelled: boolean
duration_ms: number
stdout_path: string
stderr_path: string
stdout_truncated: boolean
stderr_truncated: boolean
```

### 7.2 Git Manager：Preflight

按顺序执行等价检查：

```bash
git rev-parse --show-toplevel
git rev-parse --verify HEAD
git branch --show-current
git status --porcelain=v1 -uall
```

允许为可靠解析使用 `-z` 等非破坏性参数，但语义必须一致。

必须验证：

1. 目标目录是 Git 仓库。
2. Git 根目录与配置的项目根目录一致。
3. HEAD 存在。
4. 当前不是 detached HEAD。
5. 默认要求工作区干净。
6. 当前分支名和 HEAD SHA 可被结构化返回。
7. `.agent` 本地运行文件未被 Git 跟踪。

本地运行文件至少包括：

```text
.agent/state.json
.agent/run.lock
.agent/iteration-log.md
.agent/verification/**
.agent/evidence/**
.agent/history/**
.agent/debug/**
```

任一检查失败时返回可诊断的 `PREFLIGHT_ERROR`，不得继续创建分支。

### 7.3 Git Manager：任务分支与基线

任务分支要求：

1. 将 preflight 时的 HEAD 记录为 `base_commit`。
2. 记录原始分支。
3. 按配置模板生成 `agent/<run-id>-<task-slug>` 形式的分支名。
4. 对 `run_id` 和 `task_slug` 做安全规范化。
5. 使用 `git check-ref-format --branch` 或等价方式验证分支名。
6. 分支已存在时失败，不得覆盖或静默切换。
7. 从固定 `base_commit` 创建分支。
8. 创建失败时返回 BLOCKED 类错误。

本阶段只创建任务分支，不提交、不打 tag、不推送。

### 7.4 Diff Collector

#### 7.4.1 采集范围

每次采集都以固定 `base_commit` 为基准，至少覆盖：

- tracked 文件修改。
- tracked 文件删除。
- 新增文件。
- 文件重命名。
- untracked 文件。
- 二进制文件。

执行语义等价于：

```bash
git status --porcelain=v1 -uall
git diff --binary --find-renames <base_commit> -- .
git diff --numstat --find-renames <base_commit> -- .
git diff --name-status --find-renames <base_commit> -- .
```

#### 7.4.2 Untracked 文件

对每个 untracked 路径：

1. 规范化为相对项目根目录的 POSIX 路径。
2. 拒绝绝对路径、`..` 和项目外路径。
3. 使用 `lstat` 检查符号链接。
4. 不得跟随指向项目外部的符号链接读取内容。
5. 文本且未超过证据大小上限时，记录完整文本内容。
6. 二进制或超大文件仅记录路径、字节数、类型和 SHA-256。
7. 所有文件按规范化路径排序。

证据大小上限应可配置；默认建议为 1 MiB。

#### 7.4.3 输出 Artifact

写入：

```text
.agent/evidence/iteration-NN/
├─ tracked.diff
├─ changed-files.json
├─ untracked-files.json
└─ diff-metadata.json
```

`changed-files.json` 至少包含：

- `schema_version`
- `base_commit`
- 文件路径
- 状态：added/modified/deleted/renamed/untracked
- rename 原路径
- tracked 标识
- additions/deletions；二进制时允许为 `null`

`untracked-files.json` 至少包含：

- `schema_version`
- 路径
- 大小
- SHA-256
- 是否文本
- 是否包含完整内容
- 内容或省略原因

`diff-metadata.json` 至少包含：

- `schema_version`
- `base_commit`
- 生成时间
- tracked diff 摘要
- changed-files 摘要
- 排序后的 untracked 文件摘要
- 最终 `diff_digest`

所有 JSON 使用稳定字段和稳定排序。文件应通过现有原子写入能力落盘。

#### 7.4.4 Diff Digest

最终 SHA-256 必须由以下内容确定：

1. `base_commit`
2. `tracked.diff` 原始字节
3. 按路径排序的 untracked 文件 SHA-256
4. 规范化后的 `changed-files.json`

时间戳、绝对路径和临时目录不得参与摘要。

同一仓库状态重复采集必须得到同一 digest；任一业务文件变化必须改变 digest。

### 7.5 Scope Guard

#### 7.5.1 输入

- GOAL `allowed_changes`
- GOAL `disallowed_changes`
- `changed-files.json`
- 系统保护路径
- 本轮由编排器实际生成的文件集合

#### 7.5.2 系统保护路径

至少保护：

```text
.git/**
.agent/state.json
.agent/GOAL.md
.agent/audit-report.md
.agent/final-audit.md
.agent/run.lock
.agent/iteration-log.md
.agent/evidence/**
.agent/verification/**
.agent/history/**
.agent/debug/**
```

例外：

- Developer 可以写 `.agent/developer-handoff.md`。
- evidence、verification、history、debug 和 iteration-log 只有被调用方明确标记为
  “本轮由编排器生成”的具体文件才可从 Developer 改动集合排除。
- 不能仅凭路径位于 `.agent/evidence/**` 就假定安全，否则 Developer 可伪造证据。

#### 7.5.3 判定顺序

对每个业务改动路径严格按顺序判定：

1. 命中系统保护路径：DENY。
2. 命中 `disallowed_changes`：DENY。
3. 未命中任何 `allowed_changes`：DENY。
4. 其他情况：ALLOW。

路径匹配使用项目已有的 `micromatch`，统一使用 POSIX 相对路径。

#### 7.5.4 Scope Report

生成：

```text
.agent/evidence/iteration-NN/scope-report.json
```

至少包含：

```json
{
  "schema_version": 1,
  "passed": false,
  "allowed": ["src/a.ts"],
  "excluded_orchestrator_owned": [],
  "denied": [
    {
      "path": "package.json",
      "reason": "outside_allowed_changes"
    }
  ],
  "warnings": []
}
```

数组按路径稳定排序。

#### 7.5.5 测试保护

Scope Guard 还需检测并报告：

- 测试文件删除。
- 测试文件数量显著下降。
- 新增 `.skip`、`.only`、`xit`、`xdescribe` 等可疑标记。
- 测试配置被禁用。
- `package.json` 验证脚本被改成无操作命令。

这些信号写入 `warnings` 供后续 Auditor 判断。

以下情况直接失败：

- 测试文件删除且未被 GOAL 明确授权。
- Developer 修改系统保护文件。
- Developer 伪造编排器证据文件。

### 7.6 Verification Runner

#### 7.6.1 输入与校验

只接受 GOAL front matter 中的 `verification_commands`，每条命令必须具有：

- 唯一、非空且路径安全的 `id`
- 非空 argv 数组
- 相对项目根目录的 `cwd`
- `required` 布尔值
- 正数 `timeout_seconds`

`cwd` 解析后位于项目外时，整次验证失败且不得执行该命令。

#### 7.6.2 执行规则

1. 按 GOAL 声明顺序执行。
2. 所有命令均通过 Process Runner。
3. 默认不通过 shell。
4. 每条命令使用独立超时。
5. 一条命令失败后继续收集其余命令结果，除非用户取消。
6. required 命令必须全部 `success` 才可令 manifest `passed: true`。
7. optional 命令失败必须记录，但不机械阻止 `passed: true`。
8. 新一轮验证必须重新运行全部 required 命令，不能只重跑失败项。

#### 7.6.3 输出

日志目录：

```text
.agent/verification/iteration-NN/
├─ <command-id>.stdout.log
└─ <command-id>.stderr.log
```

最新汇总：

```text
.agent/verification/manifest.json
```

Manifest 至少符合：

```json
{
  "schema_version": 1,
  "run_id": "run-id",
  "iteration": 1,
  "passed": false,
  "started_at": "2026-06-11T00:00:00.000Z",
  "finished_at": "2026-06-11T00:01:00.000Z",
  "commands": [
    {
      "id": "unit-tests",
      "argv": ["npm", "test"],
      "cwd": ".",
      "required": true,
      "status": "failed",
      "exit_code": 1,
      "timed_out": false,
      "duration_ms": 60000,
      "stdout_path": "iteration-01/unit-tests.stdout.log",
      "stderr_path": "iteration-01/unit-tests.stderr.log"
    }
  ]
}
```

Manifest 必须原子写入。失败、超时和取消也必须留下可解析的 manifest。

required 命令失败时，调用结果需生成机械 finding 信息，编号从 `V-001` 开始，
至少包含命令 ID、状态、退出码和日志路径，供 Phase 3/4 使用。

## 8. 类型与 Schema 要求

在 `src/types.ts` 或职责相符的模块中补充严格类型，至少覆盖：

- Process Runner 输入和结果。
- Git preflight 结果。
- 任务分支结果。
- changed files。
- untracked evidence。
- diff metadata。
- scope report 和 warning。
- verification manifest 和 mechanical finding。

对落盘 JSON Artifact 提供运行时 Schema 或严格 validator，并测试：

- 缺少 required 字段时拒绝。
- enum 非法时拒绝。
- 类型错误时拒绝。
- 不允许的额外字段时拒绝。

不得仅依赖 TypeScript 编译期类型保证外部文件合法。

## 9. 错误处理

错误必须可诊断，至少区分：

- `PREFLIGHT_ERROR`
- `STATE_CONFLICT`
- `SCOPE_VIOLATION`
- `VERIFICATION_FAILED`
- Process 启动失败
- Process timeout
- Process cancelled
- Evidence path escape
- Artifact 写入失败

错误消息应包含安全的上下文，如命令 ID、相对路径和 Git 操作名称；不得包含密钥、
完整环境或未经处理的外部路径内容。

不得把机械失败转换为成功结果。

## 10. 开发范围

### 10.1 允许修改

```text
src/types.ts
src/index.ts
src/artifacts/**
src/runtime/**
src/git/**
src/scope/**
src/verification/**
tests/unit/**
tests/integration/**
package.json
package-lock.json
tsconfig.json
vitest.config.ts
eslint.config.js
.gitignore
.agent/developer-handoff.md
```

只有确有必要时才修改现有配置或依赖。优先使用 Node.js 标准库和已安装依赖。

### 10.2 禁止修改

```text
需求文档.md
DECT落地设计文档.md
Phase2开发需求文档.md
.agent/GOAL.md
.agent/plan.md
.agent/audit-report.md
.agent/final-audit.md
.agent/state.json
.agent/run.lock
src/cli/**
prompts/**
```

开发 AI 不得提交代码，不得创建 tag，不得 push。

## 11. 必需测试

### 11.1 Process Runner 单元测试

- argv 成功执行。
- 非零退出码返回 failed。
- 命令不存在时返回可诊断错误。
- cwd 逃逸被拒绝。
- stdout/stderr 分离保存。
- timeout 终止子进程。
- timeout 能终止子进程组，不留下后台进程。
- cancel 与 timeout 状态区分。
- 日志上限和截断标记。
- 敏感值脱敏。

### 11.2 Git Manager 集成测试

使用临时 Git 仓库，覆盖：

- 非 Git 目录。
- 无 HEAD 的空仓库。
- detached HEAD。
- 脏工作区。
- Git root 与项目 root 不一致。
- 本地运行 Artifact 已被跟踪。
- 正常 preflight。
- 任务分支创建。
- 分支名非法。
- 分支已存在。
- `base_commit` 固定且返回准确。

### 11.3 Diff Collector 测试

- tracked 修改、删除、新增和 rename。
- untracked 文本文件进入证据。
- untracked 二进制和超大文件只记录摘要。
- 文件名包含空格、Unicode 和特殊字符。
- 符号链接逃逸被拒绝且不读取外部内容。
- 同一状态重复采集 digest 稳定。
- tracked 或 untracked 内容变化导致 digest 改变。
- 所有输出 JSON 顺序稳定且通过 Schema。

### 11.4 Scope Guard 测试

- protected 高于 disallowed 和 allowed。
- disallowed 高于 allowed。
- 未匹配 allowed 时拒绝。
- 正常 allowed 通过。
- `.agent/developer-handoff.md` 例外。
- 编排器已登记的具体证据文件被排除。
- 未登记的伪造证据文件被拒绝。
- 未授权测试删除直接失败。
- skip/only 和无操作测试脚本产生 warning。

### 11.5 Verification Runner 测试

- 全部 required 成功时通过。
- 任一 required 失败时不通过。
- optional 失败不机械阻止通过。
- timeout 写入 manifest。
- cancel 写入 manifest。
- cwd 逃逸在执行前失败。
- 命令 ID 重复或非法时拒绝。
- 日志路径和状态准确。
- manifest 原子写入并通过 Schema。
- 下一轮重新执行全部 required 命令。

测试不得依赖真实 Codex、Claude 或网络。

## 12. 验收标准

以下全部满足才算 Phase 2 完成：

### SC-1：Preflight

能在临时仓库中准确识别合法仓库、HEAD、当前分支和干净工作区，并拒绝非仓库、
detached HEAD、无 HEAD、脏工作区及被跟踪的本地 Artifact。

### SC-2：任务分支

能从固定 `base_commit` 创建唯一合法任务分支；冲突或非法分支名不会覆盖现有分支。

### SC-3：完整 Diff

能从 `base_commit` 采集 tracked、untracked、delete、rename 和 binary 改动，且证据
不遗漏新增文件。

### SC-4：路径安全

绝对路径、`..` 和符号链接逃逸不能读取项目外内容。

### SC-5：稳定摘要

同一工作区状态重复采集产生相同 diff digest；任一纳入审计的内容变化会改变 digest。

### SC-6：范围校验

系统保护、Disallowed 和 Allowed 的优先级正确；越界改动产生失败的 scope report。

### SC-7：证据所有权

只有本轮登记为编排器生成的具体本地 Artifact 可排除，Developer 无法通过伪造
`.agent/evidence/**` 文件绕过校验。

### SC-8：测试保护

未授权删除测试时机械失败；skip/only、测试配置弱化和无操作脚本会被报告。

### SC-9：安全进程执行

Process Runner 使用 argv 和 `shell: false`，正确处理退出码、timeout、cancel、进程组、
日志截断和敏感值脱敏。

### SC-10：真实验证

Verification Runner 真实执行 GOAL 命令，required 失败不能通过，optional 失败行为符合
规则。

### SC-11：可审计 Artifact

evidence、scope report、验证日志和 manifest 均生成在约定位置，JSON 通过运行时 Schema。

### SC-12：边界守卫

Phase 2 没有实现 commit、tag、push、Agent Adapter、返工或完整主循环，也没有破坏
Phase 1 协议。

### SC-13：工程质量

以下命令全部通过：

```bash
npm audit --omit=dev
npm run typecheck
npm test
npm run lint
npm run build
npm pack --dry-run
```

### SC-14：交付说明

`.agent/developer-handoff.md` 必须准确记录：

- 实现摘要。
- 修改文件及其职责。
- 每条验收标准的对应证据。
- 实际执行的验证命令和结果。
- 未解决问题和残余风险。
- 状态只能为 `COMPLETED` 或 `BLOCKED`。

## 13. 推荐实施顺序

1. 补充类型、Artifact Schema 和测试夹具。
2. 实现 Process Runner。
3. 实现 Git parser、preflight 和任务分支。
4. 实现 Diff Collector 和稳定 digest。
5. 实现 Scope Guard 和测试保护信号。
6. 实现 Verification Runner 和 manifest。
7. 补齐临时 Git 仓库集成测试。
8. 执行全部工程验证并生成 handoff。

每完成一个模块先运行对应测试，最终仍必须重新运行完整验证。

## 14. Definition of Done

只有同时满足以下条件，Developer 才能把 handoff 标记为 `COMPLETED`：

- SC-1 至 SC-14 全部有可复验的实现或测试证据。
- 所有 required 工程验证通过。
- 没有修改禁止文件。
- 没有未解释的新依赖。
- 没有自动 commit、tag 或 push 路径。
- 没有以跳过测试或降低断言强度换取通过。
- 工作区中的实现与 handoff 描述一致。

无法满足任一硬性条件时，handoff 必须标记为 `BLOCKED` 并说明具体阻塞原因，不得
自称完成。
