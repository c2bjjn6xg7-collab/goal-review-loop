---
schema_version: 1
run_id: "20260610-goal-001"
goal_id: "goal-001"
title: "Implement Goal Review Loop - Phase 1: Protocol and State Foundation"
allowed_changes:
  - "src/**"
  - "tests/**"
  - "package.json"
  - "tsconfig.json"
  - "vitest.config.ts"
  - ".gitignore"
  - "review-loop.yaml"
  - "prompts/**"
  - ".agent/developer-handoff.md"
disallowed_changes:
  - ".git/**"
  - ".agent/state.json"
  - ".agent/GOAL.md"
  - ".agent/audit-report.md"
  - ".agent/final-audit.md"
  - ".agent/plan.md"
  - "需求文档.md"
  - "DECT落地设计文档.md"
verification_commands:
  - id: "typecheck"
    command: ["npx", "tsc", "--noEmit"]
    cwd: "."
    required: true
    timeout_seconds: 60
  - id: "unit-tests"
    command: ["npx", "vitest", "run"]
    cwd: "."
    required: true
    timeout_seconds: 120
  - id: "lint"
    command: ["npx", "eslint", "src/", "--max-warnings=0"]
    cwd: "."
    required: false
    timeout_seconds: 60
---

# Goal: Phase 1 — Protocol and State Foundation

## Objective

搭建项目基础设施，实现设计文档 §7-8 定义的核心协议和状态机制，为后续所有 Phase 提供可依赖的地基。

具体交付：

1. **项目初始化**：TypeScript + Node.js 项目，含 package.json、tsconfig、vitest、eslint
2. **目录结构**：按设计文档 §3 建立完整 src/ 目录
3. **Artifact Schema**：所有 .agent/ 文件的 JSON Schema 定义（plan、GOAL、handoff、audit-report、final-audit、iteration-log、state）
4. **YAML Front Matter 解析器**：解析 Markdown 文件中的 YAML front matter，校验必填字段
5. **State Store**：state.json 的原子读写、schema 校验、合法状态转换
6. **状态机**：11 个状态的合法转换表、转换守卫
7. **Lock Manager**：run.lock 的创建/检测/stale 处理/清理
8. **Artifact Store**：.agent/ 文件管理、历史归档（handoff/audit → history/）
9. **配置加载**：review-loop.yaml 解析和校验
10. **CLI 骨架**：Commander.js 注册 init/start/resume/status/cancel 命令（Phase 1 只实现 init）

## Success Criteria

1. `npm install` 成功，无安全漏洞警告
2. `npx tsc --noEmit` 通过，零错误
3. `npx vitest run` 通过，覆盖以下领域：
   - YAML front matter 解析（合法/非法/缺失字段）
   - State schema 校验（合法/非法 state）
   - 状态转换（所有合法转换通过，非法转换拒绝）
   - 原子文件写入（正常写入、写入失败回滚）
   - Lock Manager（创建锁、检测锁、stale 锁处理、清理锁）
   - Artifact Store（写入/读取/归档）
   - 配置加载（合法配置、缺失字段、类型错误）
4. `review-loop init` 命令可执行，能创建 .agent/ 目录和 review-loop.yaml 示例
5. 所有 Artifact 有对应的 JSON Schema，且解析器能正确校验

## Non-Goals

- 不实现 Agent 调用（Phase 3）
- 不实现 Git 操作（Phase 2）
- 不实现验证执行（Phase 2）
- 不实现主循环编排（Phase 3）
- 不实现 resume 恢复（Phase 4）
- 不实现 commit/tag（Phase 5）

## Constraints

- TypeScript strict mode
- ESM 模块系统
- Node.js 20+ 兼容
- 不引入重型框架（NestJS、Express 等）
- 原子写入使用 write-then-rename 模式
- 状态转换必须经过守卫函数，不允许直接赋值
