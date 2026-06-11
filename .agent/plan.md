---
schema_version: 1
run_id: "20260610-goal-001"
author_role: "planner"
---

# Plan: Codex + Claude Code Goal Review Loop

## Requirement Understanding

基于现有 `claude-code-review-loop` 项目（一个 Codex 插件原型），构建一套完整的本地自动化编排系统，实现：

1. **一条命令启动**：用户输入需求 → 自动完成规划、开发、验证、审计、返工、提交的完整闭环
2. **职责分离**：Codex 负责规划/审计，Claude Code 负责受控执行，编排器负责流程控制
3. **事实审计**：审计必须基于真实 diff、验证退出码和 handoff，不能仅凭模型自述
4. **可中断恢复**：流程中断后可从最近合法阶段继续
5. **安全可控**：只有最终审计通过才 commit，不自动 push，不执行破坏性 Git 命令

## Current Project Status

- 原项目 `claude-code-review-loop` 是一个最小 Codex 插件原型（7 文件，~60 行 PowerShell）
- 原项目无可复用代码，只有工作流概念可借鉴
- 当前仓库仅有需求文档和设计文档，无业务代码
- 需要从零构建独立 CLI 系统

## Technical Approach

### 技术栈

| 维度 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript 5.x | 跨平台、类型安全、生态丰富 |
| 运行时 | Node.js 20+ | 稳定 LTS |
| CLI 框架 | Commander.js | 轻量成熟 |
| 配置 | js-yaml + ajv | YAML 解析 + JSON Schema 校验 |
| 测试 | Vitest | 快速、ESM/TS 原生 |
| 日志 | pino | 结构化、低开销 |
| Glob | micromatch | Allowed/Disallowed 路径匹配 |
| 进程 | Node.js child_process | 超时、进程组终止 |

### 架构

```text
CLI (Commander.js)
  └─ Run Orchestrator (状态机 + 轮次控制)
       ├─ Agent Adapters (Planner/Developer/Auditor)
       ├─ Artifact Store (.agent/ 文件管理)
       ├─ Verification Runner (验证命令执行)
       ├─ Git Manager (预检/分支/diff/commit)
       └─ Scope Guard (文件范围校验)
```

## Work Breakdown

### Phase 1: 协议和状态基础

1. 项目初始化（package.json、tsconfig、vitest 配置）
2. 目录结构搭建
3. Artifact schema 定义（JSON Schema）
4. YAML front matter 解析器
5. State Store（state.json 读写、schema 校验、原子写入）
6. 状态机（合法转换、转换守卫）
7. Lock Manager（run.lock、进程检测、stale 处理）
8. Artifact Store（文件管理、历史归档）

### Phase 2: Git 和验证基础

1. Git Manager — Preflight（仓库检查、HEAD、工作区状态）
2. Git Manager — 分支创建（任务分支、base_commit 记录）
3. Git Manager — Diff Collector（tracked diff、untracked 文件、摘要计算）
4. Scope Guard（Allowed/Disallowed glob 匹配、系统保护路径、scope-report 生成）
5. Process Runner（argv 执行、超时、进程组终止、日志截断）
6. Verification Runner（GOAL 命令执行、manifest 生成、失败处理）

### Phase 3: Agent 编排

1. Agent Adapter 统一接口
2. Planner Adapter（输入构建、产物校验）
3. Developer Adapter（首次/返工 Prompt、产物校验）
4. Auditor Adapter（证据集构建、产物校验）
5. Prompt Builder（模板管理、占位符替换）
6. Run Orchestrator 主循环（首轮开发 → 验证 → 审计）

### Phase 4: 返工和恢复

1. 多轮返工循环（FAIL → 归档 → 返工 → 重新验证/审计）
2. History 归档（handoff/audit 归档到 history/）
3. Resume 恢复（一致性检查、分阶段恢复）
4. 超时和取消处理
5. 错误归一化（11 类错误映射）

### Phase 5: Finalization

1. Final Audit 生成
2. Pre-commit digest check（GOAL digest + diff digest 校验）
3. Commit 和可选 Tag
4. CLI 完整状态输出

### Phase 6: 质量与文档

1. 单元测试（10 个领域）
2. 集成测试（15 个场景）
3. 恢复测试（6 个崩溃点）
4. E2E 验收测试
5. 安装和配置文档
6. 故障排查文档
7. 示例仓库演示

## Risks

1. **原项目无代码可复用**：所有模块从零构建，工作量较大 → 分阶段交付，每阶段可独立验证
2. **Codex/Claude CLI 调用稳定性**：模型输出格式不可控 → 严格 schema 校验 + 容错解析
3. **跨平台进程管理**：Windows/macOS/Linux 差异 → Process Runner 统一抽象，CI 多平台测试
4. **状态恢复复杂性**：崩溃时点多样 → 每个阶段定义明确的恢复策略，测试覆盖所有崩溃点
5. **安全边界**：模型可能尝试越权操作 → Scope Guard + 系统保护路径 + 命令 denylist

## Verification Strategy

- 每个模块有独立单元测试
- 集成测试使用临时 Git 仓库 + Fake Agent
- 恢复测试模拟各阶段崩溃
- E2E 测试在示例仓库中跑通完整流程
- CI 中使用 Fake Agent，真实模型测试为可选 smoke test
