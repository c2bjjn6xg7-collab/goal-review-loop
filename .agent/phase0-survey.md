# Phase 0 调研报告：claude-code-review-loop 原项目分析

> 产出日期：2026-06-10
> 目标：分析原项目架构、技术栈、可复用模块，与设计文档的差异说明

---

## 1. 原项目概况

`claude-code-review-loop` 是一个 **Codex 插件市场包**，而非传统软件项目。它通过 Codex Plugin 机制注册为一个 Skill，让 Codex 能调度 Claude Code CLI 完成编码任务，然后 Codex 自行审查 diff。

- 仓库地址：https://github.com/diudiuyoubaigei/claude-code-review-loop
- 版本：0.1.0
- 许可证：MIT
- 总文件数：7
- 可执行代码：~60 行 PowerShell

## 2. 项目结构

```text
claude-code-review-loop/
├─ .gitignore
├─ LICENSE
├─ README.md
├─ marketplace.json                          # 插件市场元数据
└─ plugins/
   └─ claude-code-review-loop/
      ├─ .codex-plugin/
      │  └─ plugin.json                      # Codex 插件注册清单
      └─ skills/
         └─ claude-code-review-loop/
            ├─ SKILL.md                      # Skill 定义（工作流说明）
            ├─ agents/
            │  └─ openai.yaml               # Agent 接口定义
            └─ scripts/
               └─ dispatch-claude.ps1       # 唯一可执行脚本
```

## 3. 技术栈

| 维度 | 原项目 | 说明 |
|---|---|---|
| 语言 | PowerShell | 唯一可执行代码 |
| 包管理器 | 无 | 通过 `codex plugin marketplace add` 安装 |
| CLI 框架 | 无 | 脚本直接用 `param()` 接收参数 |
| 测试框架 | 无 | 零测试文件 |
| 日志框架 | 无 | `Write-Host` / `Write-Warning` |
| 构建系统 | 无 | 纯声明式，无需构建 |
| 运行时依赖 | Claude Code CLI | `claude` 命令必须在 PATH 中可用 |

## 4. 核心模块分析

### 4.1 dispatch-claude.ps1（唯一可执行模块）

功能：在目标项目目录中执行 `claude -p` 并管理超时和重试。

参数：

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `-Prompt` | string | 必填 | 任务提示词 |
| `-PromptFile` | string | 可选 | 从文件读取提示词 |
| `-WorkingDirectory` | string | 可选 | 工作目录 |
| `-PermissionMode` | enum | `bypassPermissions` | Claude Code 权限模式 |
| `-TimeoutSeconds` | int | 7200 | 最小 1800 |
| `-RetryCount` | int | 1 | 超时后重试次数 |

执行流程：
1. 校验参数
2. 切换工作目录
3. 读取 PromptFile（如提供）
4. 定位 `claude` 命令
5. 循环执行（最多 RetryCount+1 次）：
   - 通过 `Start-Job` 启动 Claude Code
   - `Wait-Job` 等待超时
   - 超时则 Stop-Job，记录输出，继续重试
   - 成功则返回输出并退出

### 4.2 SKILL.md（工作流定义）

定义了 6 步工作流：
1. Codex 读少量上下文，写清任务
2. Codex 调用 dispatch 脚本
3. Claude Code 检查文件、编辑代码、跑验证
4. Codex 审查真实 diff
5. 不合格则拒绝并返工
6. 最多 3 轮失败后停下来

### 4.3 plugin.json / openai.yaml / marketplace.json

纯声明式配置，定义插件元数据、接口和市场信息。

## 5. 可复用模块清单

| 模块 | 可复用程度 | 说明 |
|---|---|---|
| dispatch-claude.ps1 的超时/重试逻辑 | 🟡 概念可复用 | 需要用 TypeScript 重写为 Process Runner |
| SKILL.md 的工作流定义 | 🟡 概念可复用 | 需要大幅扩展为完整的状态机 |
| Codex Plugin 注册机制 | 🔴 不可复用 | 新系统是独立 CLI，不是 Codex 插件 |
| PowerShell 脚本 | 🔴 不可复用 | 新系统需跨平台，用 TypeScript |

## 6. 与设计文档的差异

| 维度 | 原项目 | 设计文档要求 | 差距 |
|---|---|---|---|
| **架构** | Codex 插件（声明式 Skill） | 独立 CLI + Run Orchestrator | 完全不同，需从零构建 |
| **语言** | PowerShell | 需跨平台 | 需选型（推荐 TypeScript/Node.js） |
| **状态管理** | 无 | state.json + 状态机 + 原子写入 | 完全缺失 |
| **文件协议** | 无 | .agent/ 目录 + YAML front matter + schema 校验 | 完全缺失 |
| **Git 操作** | 无 | Preflight + 分支 + 基线 + diff + commit + tag | 完全缺失 |
| **验证执行** | 无（Codex 手动） | Verification Runner + manifest + 日志 | 完全缺失 |
| **范围校验** | 无（Codex 手动） | Scope Guard + Allowed/Disallowed glob | 完全缺失 |
| **审计流程** | Codex 直接看 diff | Codex Auditor + audit-report + final-audit | 需结构化 |
| **返工循环** | SKILL.md 约定（3轮） | 编排器控制 + history 归档 + iteration log | 需代码实现 |
| **恢复能力** | 无 | resume + 一致性检查 + 锁管理 | 完全缺失 |
| **配置** | 脚本参数 | review-loop.yaml + schema 校验 | 需重新设计 |
| **测试** | 无 | 单元 + 集成 + 恢复 + E2E | 完全缺失 |
| **安全** | 无 | 路径校验 + 命令隔离 + 敏感信息脱敏 | 完全缺失 |

## 7. 技术选型建议

原项目没有可沿用的技术栈（PowerShell 不适合跨平台 CLI），因此需要独立选型：

| 维度 | 推荐方案 | 理由 |
|---|---|---|
| 语言 | TypeScript | 跨平台、类型安全、生态丰富 |
| 运行时 | Node.js 20+ | 稳定、广泛支持 |
| CLI 框架 | Commander.js | 轻量、成熟、TypeScript 友好 |
| 配置解析 | js-yaml + ajv | YAML 解析 + JSON Schema 校验 |
| 测试框架 | Vitest | 快速、ESM 原生、TypeScript 原生 |
| 日志 | pino | 结构化日志、低开销 |
| 文件操作 | fs-extra + graceful-fs | 原子写入、跨平台 |
| Glob 匹配 | micromatch | Allowed/Disallowed 路径匹配 |
| 进程管理 | Node.js child_process | 超时、进程组终止 |
| Git 操作 | 简单封装 git CLI | 不引入 libgit2 依赖，保持可控 |

## 8. 结论

原项目是一个**最小可行原型**——一个 Codex 插件声明 + 一个 PowerShell 调度脚本。它的核心价值是**工作流概念**（Codex 规划 → Claude 执行 → Codex 审查 → 返工），而非可复用的代码。

新系统需要在原项目的**概念基础上**从零构建：
- 独立 CLI（不是 Codex 插件）
- 完整的状态机和文件协议
- 自动化的验证、审计和 Git 管理
- 跨平台支持（macOS/Linux/Windows）
- 全面的测试覆盖

**原项目可复用的只有设计思想，没有可复用的代码。**
